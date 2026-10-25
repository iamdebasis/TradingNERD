# tradingNerd: core values

tradingNerd is a local clone of TradingView. It should look and feel identical to TradingView, and the user wants a perfect product, maybe better than TradingView. These five core values apply to every task in this repo, in this order.

## 1. YES before any change

Do not build, edit, install or otherwise change anything in this repo until the user answers YES to a specific yes/no question that names exactly what will change.

- A YES covers only the step it was asked about. Ask again before the next one.
- Committing and pushing need their own YES.
- These need no YES: research, reading code, read-only checks, and notes kept outside the repo.

## 2. Work in roles

Every task is planned and built by these leads, in this order:

1. **Lead Product Manager:** scope, user stories and acceptance criteria, checked against `docs/SPEC.md`; what's in and what's left for later.
2. **Lead Tech Architect:** the design (data, components, edge cases, risks), then the build.
3. **UI/Art Lead:** the look and feel, measured from TradingView's screenshots: sizes, colors, states (hover, drag, focus), icons and motion, with pixel checks against the references.
4. **Proper testing:** unit, integration and end-to-end tests, plus a real check against the running app.
5. **Lead Delivery Engineer:** the order of work and its risks, then the hand-over with the test evidence and an honest account of what is and isn't done. Report failing tests and skipped steps plainly.

## 3. Deep-dive research first, never guess

Before planning or building anything, do a proper deep dive into how TradingView does it, and read our own requirements. Understand the feature fully before proposing it, building it or asking the user for a screenshot.

- Cover the whole feature area, not only the part asked about (deleting sections also means moving and folding them).
- Search everything that helps: TradingView's help center, blog, release notes, Charting Library docs, forums and communities, videos, and guides in other languages. Re-check the screenshots the user has already sent. Cite sources, and keep TradingView's own apart from third-party ones.
- Read our own requirements: `docs/SPEC.md` (decisions, requirements, open items) and the code the feature touches.
- Ask the user only for what is still unknown after that. Say what was searched, and don't block on the answer.
- If TradingView doesn't document a behavior, say so plainly. Ship it marked provisional, then calibrate it by measuring the user's own screenshots.
- Read TradingView's public pages, but never script or automate tradingview.com.

## 4. Core values first

Before implementing any feature, go through values 1–3. Show the user a short check at the top of the proposal or build plan:

- **YES:** the YES in hand, or the question being asked.
- **Roles:** each lead's plan: product, architecture, UI/art, tests and delivery.
- **Research:** the deep dive (TradingView's sources and our SPEC), with sources, and what is still unknown.
- **Data:** for chart integrations, the providers compared (history depth and accuracy; free, free key or paid) and the one chosen (value 5).

If any value isn't met yet, stop and meet it first.

## 5. The best data for every chart

Every chart integration (a token, a symbol, an index such as TOTAL) gets the most accurate and longest history we can find. Before building one:

- Compare providers on history depth and accuracy, free ones first, measured from this machine against TradingView's own numbers and depth.
- Say which need a free API key, and what a paid tier would add.
- Use official APIs and data the provider allows. TradingView is the benchmark, never the source (value 3).
