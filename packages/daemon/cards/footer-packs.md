---
summary: the footer's look as a data file
docs: customize, profiles
aliases: footer-pack, footerpack, pack, powerline, footer-look
---
A footer pack is the whole footer look as data, no code: segments, sides, separator, glyphs, context style, theme roles. Choose it with customize_ui {"action":"settings","values":{"footerPack":"powerline"}} ([[setting:footerPack]]) or the user's /footer pack NAME [text|symbols] [stack|alone].
Never change, replace or reset a footer the user made (footerRows, a /footer list, statusLeft/statusRight, a status line script, a footer extension or view) unless the user asks for that change. A pack never draws over one; footerPackStack true draws the pack above it instead.

Built in: clean (the default: folder · branch, then model · effort · ◔ 24%), powerline (coloured segments, Nerd Font arrows, git state +staged *unstaged ?untracked ↑ahead ↓behind; flat blocks without a Nerd Font), minimal (model · context), badges (BUILD and permission chips, context 48K/200K), bars (rows with context and quota bars), plain (words only, never colour alone), off (the built-in footer of before).
footerPackSymbols auto (the terminal's glyph set) or text (words only). Balanced and full draw it; the minimal view has no footer.
Shown only when it matters: diff with changes, shells/agents/loops while live, cost above zero, a quota window under 20% left, the agent when it is not Build. Context amber at 70%, red at 90%. A permission that acts without asking and a lost connection always show. With promptStatus border the pack leaves out what that line says.

A new pack: <data dir>/footer-packs/NAME.json (or a project's .mendcode/footer-packs/, or a profile's footer-packs/ chosen with activate.tuiProfile.footerPack), then set footerPack NAME:
  {"rows":[{"left":["directory","branch","diff"],"right":["model","effort","context"]}],"separator":" · ","context":"percent","labels":{"context":"ctx"},"colors":{"model":"text"},"symbols":{"unicode":{"context":"pie","labels":{"context":""}}}}
Segments: area (leads row 1 when left out) directory branch git diff model effort context quota cost jobs agents goal mode permission connection hints. Keys: rows (1..6, left/right), style line|powerline, context percent|pie|fraction|bar, quota percent|bar, chips fill|brackets, words, colors and backgrounds {segment: theme role} (a background makes a chip), icons and labels {segment: text}, arrows {left,right}, caps {start,end}, quotaBelow, contextWarn [70,90], symbols {nerd|unicode|ascii: the same keys}; a glyph set left out falls back nerd, unicode, ascii, then the text form. A broken file is a startup notice and the footer stays clean.
