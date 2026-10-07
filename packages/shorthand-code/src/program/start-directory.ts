/**
 * Preloaded before everything else in a program: moves into the directory the program was run from. On macOS,
 * asking the system for the working directory fails (ENOENT) in a subdirectory of the AgentFS mount once a file
 * has been read there, so the program starts at the workspace root, moves here, and reads it at once.
 */
const start = process.env.PI_SHORTHAND_START_DIRECTORY;
if (start && start !== process.cwd()) {
	process.chdir(start);
	process.env.PWD = start;
	// Read once now, while the lookup still works: Bun keeps the answer, and gives it to the processes it starts as
	// their explicit working directory, rather than each asking the system again.
	process.cwd();
}
delete process.env.PI_SHORTHAND_START_DIRECTORY;
