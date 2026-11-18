# Chrome Web Store listing

## Summary (132 characters max)

A button on every post on X that saves its link to Apple Reminders in one click. Never twice. For Mac, with a small helper app.

## Description

X to Reminders adds one button to every post on X, just before Bookmark. Click it and the post's link becomes a new reminder in your default Apple Reminders list. The button turns into an orange tick.

- Never twice: posts already in any of your Reminders lists show the tick, wherever you saved them from.
- Adds only: it never edits, completes or deletes a reminder.
- Stays on your Mac: no account, no server, no tracking. The extension talks to a small open-source helper app on your Mac, which talks to Reminders.
- Fits in: the same size, colour and spacing as X's own icons, in light and dark themes, in English and French.

Needs macOS and the free helper app, installed with one command: https://github.com/Soren-Starck/x-to-reminders#install

Open source (MIT): https://github.com/Soren-Starck/x-to-reminders
Not affiliated with X Corp. or Apple.

## Category and language

Productivity. English (the extension itself also speaks French).

## Privacy practices

- Single purpose: adds a button to posts on x.com that saves the post's link to the user's Apple Reminders.
- nativeMessaging: sends the link of the post the user clicked to the companion helper app on the user's Mac, which creates the reminder with Apple's EventKit.
- scripting: after an install or update, puts the button back in x.com tabs that were already open, so the user does not have to reload them.
- Host permissions (x.com, twitter.com): the button is drawn inside posts on these sites; nothing else is read or changed.
- Remote code: none.
- Data use: collects no user data. Privacy policy: https://github.com/Soren-Starck/x-to-reminders/blob/main/PRIVACY.md
