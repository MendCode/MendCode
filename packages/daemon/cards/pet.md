---
summary: the pet companion: choose, turn off, make a custom one
docs: customize, fetch
aliases: mascot, companion, sprite, mend
---
For: "turn the pet off", "give me a different pet", "make a pet of a blue owl", "show the mascot on the start screen".

The pet is a terminal decoration (feature pets, tier full; hidden below it). It never reaches a model and changes nothing about a turn.
  Choose or turn off (the user): /pet opens the picker (Enter: prompt and start screen, o: off); /pet off turns it off at once; the Pet row in /customize Terminal does the same. It is the profile key [[setting:pet]], so customize_ui {"action":"settings","values":{"pet":"off"}} also works for you; the value is a pet id from the picker. Its size in a session is [[setting:petSize]] (small 10x5 cells, medium 16x8 the default, large 24x12): /pet small|medium|large, or the Pet size row.
  A pet on the start screen (above or beside the title; same feature, tier full): /mascot opens the list, /mascot <pet name> puts that pet there, /mascot mend is the built-in Mend, /mascot off the title alone, /mascot animated|static its motion, /mascot small|medium|large its size. The keys are [[setting:homeMascot]] (mend, or a pet reference such as user:<id>), [[setting:mascotMotion]] and [[setting:mascotSize]], shown when logoKind is mascot or both: customize_ui {"action":"settings","values":{"logoKind":"both","homeMascot":"user:<id>","mascotSize":"medium"}}. A medium pet needs 30 rows (26 beside the title on 92 columns); smaller screens try a smaller box, then the ASCII Mend; 16 colors and ASCII glyphs show the text Mend; reduced motion holds it still. The old value mendy reads as mend.
  Import a picture as a pet (the user; free, no image call, local files only): /pet import <file.png|file.gif|folder> [--name N] [--frames COLSxROWS] [--ms N] [--filter pixel|smooth] [--no-key]. One PNG is a still pet; --frames cuts a sprite sheet (rows are states, columns frames); a GIF or a folder of numbered PNGs is an animation; a folder of idle/, working/ ... folders gives one animation per state. Folder-only: thinking, compacting, agents, sleeping. A flat background is removed unless --no-key. JPEG and WebP are not read. You cannot run it: a session's own shell is refused pet.manage.
  Custom pet (experimental, feature pet_generator, tier full, off until the user runs it): /pet new <description> [--frames 1-4] [--usd 0.10] shows the image calls (six; --frames N: an N-frame loop a state, N calls), the model and the cost, and waits for confirmation. Each state keeps the reference's size and baseline. It needs image generation on with a model; safe mode, a deny rule or plan mode block it. Never start it yourself: it spends money. /pet regen user:<id> <state> redraws a state, /pet rename and /pet delete --confirm manage installed pets (data dir, pets/<id>/pet.json).

On this machine: the live line shows the tier and whether pets are on.

Check: the picker lists the pet as chosen; you cannot see the pet itself, so say the look was not verified visually.

Not possible: a pet that talks or acts, a pet outside the full tier, generating without image-generation credentials.
