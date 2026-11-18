# Privacy

Nothing X to Reminders handles leaves your Mac.

- The extension runs on x.com and twitter.com only. It reads the address of each post on the page to know which post a button belongs to.
- When you click the button, the extension passes that one address to the X to Reminders helper app on your own Mac (Chrome's native messaging), and the helper adds it to Apple Reminders with Apple's EventKit. Reminders syncs it through your own iCloud account, as with any reminder you create.
- To show which posts are already saved, the helper reads your open reminders on your Mac and returns only the ids of X posts found in them.
- Nothing is sent to any server, there is no account, no analytics and no tracking. The helper keeps a short log of its requests (post addresses and counts) in `~/Library/Logs/X to Reminders/host.log` on your Mac, which you can delete at any time.

Questions: open an issue at https://github.com/Soren-Starck/x-to-reminders/issues.
