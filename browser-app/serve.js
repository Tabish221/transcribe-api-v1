// Serves transcriber.html on http://localhost:8080 so the browser can cache the Whisper model.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 8080;
const FILE = path.join(__dirname, "transcriber.html");

http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/transcriber.html") {
    res.writeHead(404); return res.end("Not found");
  }
  fs.readFile(FILE, (err, data) => {
    if (err) { res.writeHead(500); return res.end(String(err)); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Transcriber running at ${url}  (close this window to stop)`);
  exec(`start "" "${url}"`);
});
