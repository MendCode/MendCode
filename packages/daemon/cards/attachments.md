---
summary: images, PDFs and files in a message; read images; generate images; voice
docs: attachments, voice, tools-web
aliases: attach, attachment, image, images, paste, pdf, screenshot, dictate, voice, drag-drop
---
For: "attach this image / PDF / folder", "look at this screenshot", "what is in this picture", "make an image", "dictate instead of typing".

The user's way: /attach <path> (project files insert @path; an external text file is inlined up to 200 KiB; an external folder becomes a sorted listing), drop or paste a path, or the clipboard key for an image. It enters the prompt as a token at the cursor ([Image #1], [PDF name.pdf]); pasted images may be up to 20 MiB, PDFs 5 MiB. Profile key [[setting:attachmentChips]] inline|above|both; [[setting:images]] auto|kitty|iterm2|sixel|off chooses how the terminal draws images.

Model tools:
  read {path}: text, folders, PNG/JPEG/GIF/WebP and PDFs (inline images and PDFs up to 5 MiB; 2,000 lines by default, long lines cut at 2,000 characters).  screenshot (macOS only): the screen, front window or a region as an image, at most 1600 px; asks for approval.
  image_gen {prompt, size?, n?, path?, referenced_image_paths?}: only for an explicit image request; uses the separate image provider and model (daemon setting [[setting:image_generation]], also needed by the pet generator); it writes managed artifacts or a path inside the project and never overwrites; approval applies. In a Claude Code session it is mcp__mendcode__image_gen (feature harness_tools) and works unconfigured with the ChatGPT login or a saved OpenAI key; never send the user to another engine for an image.
  While an image is generated its card is an animated ASCII canvas with the model and size (/customize, section Image generation: imageWait animated|static, imageWaitPreset drops|cycle|constellation|orbit|pulse|scanner or a name from imageWaitArt, imageWaitSpeed ms per frame, imageWaitColor, imageWaitMeta; imageWaitArt and imageWaitCanvas in tui/profile.json). Reduced motion holds its first frame.

Voice: /voice or ctrl+x v starts recording, again stops and puts the transcript in the prompt to review (esc drops the clip). Full tier; the user turns it on with /voice on (voice.enabled). The clip is uploaded to an OpenAI-compatible transcription endpoint, so it is opt-in; a ChatGPT login is not an API key and does not work. It needs an installed recorder (rec/sox, arecord, ffmpeg); /voice status says what is missing. Setting [[setting:voice]]: provider, model, base_url, language (es), max_seconds 5 to 300.

Data honesty: an attachment is read by the model only when it is sent; a path outside the project is read only if the user attached it. If the image or PDF did not load, say so; do not describe what you did not see.

Not possible: sending a file to another program or user from here (use the shell under approvals); listening to the microphone without /voice on.

Check: the token or chip appears in the prompt; read of an image returns an image, not text.
