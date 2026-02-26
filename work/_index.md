# Work

## PetRadar
- **What**: Startup focused on reuniting missing pets
- **Setup**: Remote team
- **Role**: Co-founder & CEO — but day-to-day is mostly front-end coding and product development
- **Co-founder**: Tom (see `people/tom.md`)
- **Colleague**: Alex
- **Duration**: Several years
- **Background**: Commercial internet marketing; transitioning toward product and web development
- **Current project**: Charachorder chord library (3 weeks, Feb 2026) — not directly PetRadar work but investment in tooling/interface. Created guilt about not contributing to the company. Integration phase next (post-Argentina).

## Career history
- See `work/career.md` — Breeze (dating app, ~1.5yr) → PetRadar (current)

## Telegram Bot (David OS mobile access)
- **Code**: `telegram-bot/` — grammY bot using Claude Agent SDK
- **Architecture**: Telegram channel + linked discussion group. Each channel post = new session, comment threads = continued conversation.
- **Deployment**: runs via **pm2** (not systemd). Commands: `pm2 start/stop/restart davidclaude-bot`, logs at `pm2 logs davidclaude-bot`
- **Config**: `telegram-bot/.env` — bot token, discussion group chat ID, allowed user IDs

## Work philosophy
Wants to work from strategy, not fear — rest is investment in personal life. See `growth/insights.md` > Work & achievement for deeper context.

## Files
| File | Contents |
|------|----------|
| `career.md` | Career history — Breeze → PetRadar, career direction |
| `business-ideas.md` | Business ideas under consideration |
| `startup-insights.md` | Startup evaluation criteria and principles |
