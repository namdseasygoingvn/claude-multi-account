// CI gate (Windows): prove node-pty's win32-x64 prebuild actually loads AND
// spawns a PTY under Electron's runtime — the one native-module risk in this
// app. Runs as an Electron main process (no window); exits non-zero on any
// failure so the build fails loudly instead of shipping a broken installer.
//
// .cjs because package.json is "type":"module" — Electron's main can be CommonJS.
const { app } = require('electron');

app.whenReady().then(() => {
  let pty;
  try {
    pty = require('node-pty');
  } catch (err) {
    console.error('smoke: node-pty failed to LOAD under Electron:', err && err.message);
    app.exit(1);
    return;
  }

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  let term;
  try {
    term = pty.spawn(shell, [], { cols: 80, rows: 24 });
  } catch (err) {
    console.error('smoke: node-pty loaded but pty.spawn threw:', err && err.message);
    app.exit(1);
    return;
  }

  let bytes = 0;
  term.onData((d) => {
    bytes += d.length;
  });

  // Give the shell a moment to emit its banner/prompt, then assert we got output.
  setTimeout(() => {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    if (bytes > 0) {
      console.log(`smoke: node-pty OK under Electron — spawned ${shell}, received ${bytes} bytes`);
      app.exit(0);
    } else {
      console.error(`smoke: node-pty spawned ${shell} but produced no output`);
      app.exit(1);
    }
  }, 2000);
});
