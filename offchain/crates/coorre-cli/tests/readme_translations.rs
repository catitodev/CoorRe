#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::collections::BTreeSet;
use std::path::Path;

const README: &str = "README.md";
const POINTER: &str = "README.pt-BR.md";
const PORTUGUESE_SUMMARY: &str = "<summary><b>Ler em português (Brasil)</b></summary>";
const ENGLISH_OPENING: &str = "CoorRe solves the lack of verifiable coordination";
const PORTUGUESE_OPENING: &str = "O CoorRe resolve a falta de coordenação verificável";

fn read(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(name);
    std::fs::read_to_string(&path).expect("the README is readable")
}

struct Readme {
    head: String,
    portuguese: String,
    english: String,
}

fn split() -> Readme {
    let text = read(README);
    let summary = text
        .find(PORTUGUESE_SUMMARY)
        .expect("the Portuguese block is present");
    let close = format!("\n</details>\n\n{ENGLISH_OPENING}");
    let end = text
        .find(&close)
        .expect("the Portuguese block closes right before the English text");
    let open = text[..summary]
        .rfind("<details>")
        .expect("the Portuguese block is collapsed");
    Readme {
        head: text[..open].to_owned(),
        portuguese: text[summary + PORTUGUESE_SUMMARY.len()..end].to_owned(),
        english: text[end + "\n</details>\n\n".len()..].to_owned(),
    }
}

fn between<'a>(text: &'a str, open: &str, close: char) -> Vec<&'a str> {
    text.match_indices(open)
        .filter_map(|(i, _)| {
            let rest = &text[i + open.len()..];
            rest.find(close).map(|end| &rest[..end])
        })
        .collect()
}

fn targets(text: &str) -> BTreeSet<String> {
    between(text, "](", ')')
        .into_iter()
        .chain(between(text, "src=\"", '"'))
        .chain(between(text, "srcset=\"", '"'))
        .chain(between(text, "href=\"", '"'))
        .map(str::to_owned)
        .chain(
            between(text, "<https://", '>')
                .into_iter()
                .map(|rest| format!("https://{rest}")),
        )
        .collect()
}

fn fenced(text: &str, language: &str) -> Vec<String> {
    text.split(&format!("```{language}\n"))
        .skip(1)
        .map(|block| block.split("```").next().unwrap().to_owned())
        .collect()
}

fn headings(text: &str) -> usize {
    text.lines().filter(|l| l.starts_with("## ")).count()
}

#[test]
fn the_readme_opens_with_the_problem_and_keeps_portuguese_collapsed_on_top() {
    let readme = split();
    assert_eq!(headings(&readme.head), 0);
    assert!(readme.english.starts_with(ENGLISH_OPENING));
    assert!(
        readme
            .portuguese
            .trim_start()
            .starts_with(PORTUGUESE_OPENING)
    );
    let text = read(README);
    assert_eq!(
        text.matches("<details>").count(),
        text.matches("</details>").count()
    );
}

#[test]
fn the_portuguese_file_only_points_to_the_readme() {
    let pointer = read(POINTER);
    assert_eq!(pointer.lines().count(), 1);
    assert!(pointer.contains(&format!("]({README})")));
    assert!(pointer.contains("Ler em português (Brasil)"));
}

#[test]
fn both_languages_have_the_same_structure() {
    let readme = split();
    let (en, pt) = (&readme.english, &readme.portuguese);
    assert_eq!(headings(en), headings(pt));
    for tag in [
        "<details>",
        "</details>",
        "<picture>",
        "<img ",
        "| --- |",
        "|---|",
    ] {
        assert_eq!(en.matches(tag).count(), pt.matches(tag).count(), "{tag}");
    }
    assert_eq!(fenced(en, "mermaid").len(), fenced(pt, "mermaid").len());
}

#[test]
fn both_languages_carry_the_same_commands_links_images_and_figures() {
    let readme = split();
    let (en, pt) = (&readme.english, &readme.portuguese);
    assert_eq!(fenced(en, "bash"), fenced(pt, "bash"));
    assert_eq!(targets(en), targets(pt));
    for figure in [
        "62%",
        "39%",
        "15%",
        "0%",
        "40%",
        "21%",
        "27%",
        "19%",
        "10 to 15%",
        "USD 492",
        "45",
        "200",
        "1,053",
    ] {
        let localized = match figure {
            "10 to 15%" => "10 a 15%",
            "USD 492" => "US$ 492",
            "1,053" => "1.053",
            other => other,
        };
        assert!(en.contains(figure), "{figure} missing in English");
        assert!(pt.contains(localized), "{localized} missing in Portuguese");
    }
    assert!(readme.head.contains("Provable decisions for AI agents."));
}

#[test]
fn the_readme_avoids_the_words_the_narrative_rules_out() {
    let text = read(README).to_lowercase();
    for word in [
        "regenerativ",
        "mvp",
        "pilot",
        "piloto",
        "bulletproof",
        "fraud-proof",
    ] {
        assert!(!text.contains(word), "{word}");
    }
    let words: Vec<&str> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    for pair in words.windows(2) {
        let feminine = ["a", "da", "na", "pela"].contains(&pair[0]) && pair[1] == "coorre";
        assert!(!feminine, "{} {}", pair[0], pair[1]);
    }
}

#[test]
fn every_relative_target_exists() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for name in [README, POINTER] {
        for target in targets(&read(name)) {
            if target.starts_with("http") || target.starts_with('#') {
                continue;
            }
            assert!(root.join(&target).exists(), "{name}: {target}");
        }
    }
}
