# tradingNerd: core values

tradingNerd is a local clone of TradingView. It should look and feel identical to TradingView, and the user wants a perfect product, maybe better than TradingView. These four core values apply to every task in this repo, in this order.

## 1. YES before any change

Do not build, edit, install or otherwise change anything in this repo until the user answers YES to a specific yes/no question that names exactly what will change.

- A YES covers only the step it was asked about. Ask again before the next one.
- Committing and pushing need their own YES.
- These need no YES: research, reading code, read-only checks, and notes kept outside the repo.

## 2. Work in roles

Every task goes through four roles:

1. **Lead Product Owner:** scope, user story, acceptance criteria.
2. **Lead Software Architect/Engineer:** design, then build.
3. **Proper testing:** unit, integration and end-to-end tests, plus a real check against the running app.
4. **Lead Delivery Engineer:** hand over with the test evidence and an honest account of what is and isn't done. Report failing tests and skipped steps plainly.

## 3. Research TradingView first, never guess

Whenever the user talks about a feature, first learn exactly how TradingView does it. Understand it fully before proposing it, building it or asking the user for a screenshot.

- Search TradingView's help center, blog, release notes, Charting Library docs and forums. Re-check the screenshots the user has already sent. Cite sources.
- Ask the user only for what is still unknown after that. Say what was searched, and don't block on the answer.
- If TradingView doesn't document a behavior, say so plainly. Ship it marked provisional, then calibrate it by measuring the user's own screenshots.
- Read TradingView's public pages, but never script or automate tradingview.com.

## 4. Core values first

Before implementing any feature, go through values 1–3. Show the user a short check at the top of the proposal or build plan:

- **YES:** the YES in hand, or the question being asked.
- **Roles:** the product, design, test and delivery plan.
- **Research:** what was researched, with sources, and what is still unknown.

If any value isn't met yet, stop and meet it first.
