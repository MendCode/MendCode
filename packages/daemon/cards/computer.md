---
summary: control the screen and apps (macOS), or drive a headless browser
docs: computer, browser, tiers
aliases: screen, mouse, click, desktop, gui, chromium, headless-browser, automation-gui, accessibility-api
---
For: "open the Notes app and type something", "click that button", "test my site in a browser", "take a screenshot of the window". Two different things; pick by target.

A real macOS app: the computer tools (feature computer, macOS only). They are off until the user runs /tier computer on (no restart; no tier turns them on); if they are missing, say so and name that switch instead of falling back to screenshot. Disabled means no helper, no compile, no capture, no OS prompt. First use compiles a small Swift helper with Apple's Command Line Tools (xcode-select --install) and needs two macOS permissions for the terminal or daemon: Accessibility, and Screen Recording for captures. MendCode never grants them itself, and approval inside MendCode is separate from the OS permission.
  computer_session {action: apps|start|stop, ...}: lists GUI apps (no activation) and opens a session on one. computer_observe {computerSessionID, screenshot?}: a revisioned accessibility tree of the app. computer_code {computerSessionID, code}: a short confined program of operations (click, type, keys) that keeps one input lease. computer_capture {region?, windowID?} and computer_key {captureID, key} for screenshots and navigation keys. Binding an app asks once in the modes that ask; full access binds and acts without a card. A restart or cancel never replays an action. In a browser a plain click on a link, tab or label presses it.
  screenshot (plain macOS tool): the screen, the front window or a region as an image, at most 1600 px.

A web page or your dev server: the browser tool (feature browser, tier full, the user's MENDCODE_BROWSER=1; tools: { browser: false } turns it off per project). It launches the Chrome, Chromium, Edge or Brave already installed (MENDCODE_BROWSER_PATH picks one), headless, with a throwaway profile; it is not the user's own browser and has none of their logins.
  browser {action: navigate|snapshot|click|type|press|scroll|back|wait|screenshot|console|close, plus tabs, open_tab, select_tab, close_tab}: snapshot gives page text and numbered elements ([3] button "Save"); click and type take that ref and go stale after navigation, so snapshot again. Passwords and one-time-code fields are never shown. Downloads are denied; dialogs are dismissed. Limits: 8 tabs per chat, 4 chats with a browser, idle 10 minutes closes it.

Before promising either: read "On this machine now". If it says off, say what is off and the switch (/tier computer on; MENDCODE_BROWSER=1 when the daemon starts, full tier, for the browser); do not substitute osascript or a shell script for a click without telling the user.

Not possible: Windows or Linux desktop control; reading the user's browser tabs or logins; typing into password fields of the page.

Approvals for each action: {{program}} docs permissions.

Check: observe or snapshot after each action and compare with what was meant; if a permission is missing the tool says which.
