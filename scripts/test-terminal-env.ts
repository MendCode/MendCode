/**
 * Test preload: the terminal a test run happens in must not change what the tests see. Inside tmux, screen or tuios the app
 * turns pictures off (apps/cli/src/pets/detect.ts), and a test that builds the app without its own `env` reads the real one,
 * so the same suite passed in Ghostty and failed in a multiplexer. A test that wants a multiplexer passes it in its own env.
 */
for (const name of ["TMUX", "TMUX_PANE", "STY", "TUIOS_ENV"]) delete process.env[name]
if (process.env.TERM_PROGRAM?.toLowerCase() === "tuios") delete process.env.TERM_PROGRAM
