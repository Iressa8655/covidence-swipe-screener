# Covidence Swipe Screener

A Chrome extension for faster title and abstract screening in [Covidence](https://www.covidence.org/).

- **Swipe or arrow keys.** ← No, → Yes, ← and → together (or ↑ / ↓) Maybe, Esc to close. Touchpad: two-finger swipe left No, right Yes, two-finger tap Maybe.
- **A protocol per review.** The first time you open a review, it asks for your framework (PICOS, PECOS, SPIDER, PICo, PCC, SPICE or Other, the same list as Covidence), then you paste your eligibility criteria and search string once and it pulls out the keywords to highlight. Each Covidence review keeps its own, and you can edit it any time with **P**.
- **Keyword highlighting.** Each framework field gets its own colour, other keywords are pink and exclusion flags are red. A trailing `*` works as truncation (`child*`).
- **Criteria on every card.** Your inclusion and exclusion criteria sit at the top of each study.
- **Structured abstracts.** Abstracts are split into Intro, Methods, Results and Discussion. Existing labels are used when present. Otherwise headings are guessed from the wording and marked as guessed.

Votes are cast by clicking Covidence's own buttons, so everything is saved in Covidence as normal.

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Open a Covidence screening page and press **S**.
5. Fill in the protocol form the first time, then screen.

## Notes

- Not affiliated with or endorsed by Covidence.
- No data leaves your browser. Terms are stored with `chrome.storage.local`.
- Covidence may change its page layout. If the card shows no studies, please open an issue.

## Licence

MIT
