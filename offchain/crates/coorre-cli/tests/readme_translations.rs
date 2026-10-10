#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::collections::BTreeSet;
use std::path::Path;

const ENGLISH: &str = "README.md";
const PORTUGUESE: &str = "README.pt-BR.md";

fn read(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(name);
    std::fs::read_to_string(&path).expect("the README is readable")
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
    let mut found: BTreeSet<String> = between(text, "](", ')')
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
        .collect();
    found.remove(ENGLISH);
    found.remove(PORTUGUESE);
    found
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
fn both_readmes_link_to_each_other() {
    assert!(read(ENGLISH).contains(&format!("href=\"{PORTUGUESE}\"")));
    assert!(read(PORTUGUESE).contains(&format!("href=\"{ENGLISH}\"")));
}

#[test]
fn both_readmes_have_the_same_structure() {
    let (en, pt) = (read(ENGLISH), read(PORTUGUESE));
    assert_eq!(headings(&en), headings(&pt));
    for tag in ["<details>", "<picture>", "<img ", "| --- |", "|---|"] {
        assert_eq!(en.matches(tag).count(), pt.matches(tag).count(), "{tag}");
    }
    assert_eq!(fenced(&en, "mermaid").len(), fenced(&pt, "mermaid").len());
}

#[test]
fn both_readmes_carry_the_same_commands_links_images_and_figures() {
    let (en, pt) = (read(ENGLISH), read(PORTUGUESE));
    assert_eq!(fenced(&en, "bash"), fenced(&pt, "bash"));
    assert_eq!(targets(&en), targets(&pt));
    for figure in [
        "15%",
        "0%",
        "97%",
        "95%",
        "21%",
        "27%",
        "40%",
        "19%",
        "33%",
        "10 to 15%",
        "492",
        "75",
        "22",
        "200",
        "1,053",
    ] {
        let localized = match figure {
            "10 to 15%" => "10 a 15%",
            "1,053" => "1.053",
            other => other,
        };
        assert!(en.contains(figure), "{figure} missing in {ENGLISH}");
        assert!(
            pt.contains(localized),
            "{localized} missing in {PORTUGUESE}"
        );
    }
    assert!(pt.contains("Provable decisions for AI agents."));
}

#[test]
fn every_relative_target_exists() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for name in [ENGLISH, PORTUGUESE] {
        for target in targets(&read(name)) {
            if target.starts_with("http") || target.starts_with('#') {
                continue;
            }
            assert!(root.join(&target).exists(), "{name}: {target}");
        }
    }
}
