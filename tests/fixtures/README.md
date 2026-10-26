# Test fixtures

These CSV files are **synthetic imitations** of the documented layouts of the public datasets supported by the
importer (TripAdvisor "Dyadic Context" restaurant reviews; Inside Airbnb `reviews.csv` + `listings.csv`).
They were written for the tests; they contain no real reviews, people, emails or phone numbers
(`owner@example.com`, `+44 20 7946 0958` and `www.example.com` are reserved/fictional examples).

They deliberately include awkward cases: quoted newlines and quotes, HTML entities/tags, PII-like strings,
non-English text, too-short text, an unparseable date, exact duplicate text, an automated Airbnb posting and
a review for an unknown listing.

**The real files could not be downloaded in the authoring environment**, so the adapters are verified against these
fixtures only. See docs/DATASETS.md.
