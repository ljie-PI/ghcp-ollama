#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import minimist from "minimist";

const HOME_DIR = process.env.HOME || process.env.USERPROFILE;
const DEFAULT_PID_FILE = path.join(HOME_DIR, ".ghcpo-server", "pidfile");
const LOG_DIR = path.join(HOME_DIR, ".ghcpo-server", "log");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const argv = minimist(process.argv.slice(2), {
  string: ["pidfile"],
  boolean: ["help"],
  alias: {
    h: "help",
    p: "pidfile",
  },
  default: {
    pidfile: DEFAULT_PID_FILE,
  },
});

if (argv.help) {
  const commandName = path.basename(process.argv[1]);
  console.log(`
GitHub Copilot Ollama Server Control Tool

Usage: ${commandName} <command> [options]

Commands:
  start                 Start the server
  stop                  Stop the server
  restart               Restart the server
  status                Check server status

Options:
  --pidfile, -p         Path to PID file (default: ${DEFAULT_PID_FILE})
  --help, -h            Show this help message

Examples:
  ${commandName} start
  ${commandName} stop
  ${commandName} restart
  ${commandName} status
  `);
  process.exit(0);
}

const command = argv._[0] || "status";
const pidFile = argv.pidfile;

function writePid(pid) {
  fs.writeFileSync(pidFile, pid.toString(), "utf8");
}

function readPid() {
  try {
    if (fs.existsSync(pidFile)) {
      return parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    }
  } catch (err) {
    console.error(`Error reading PID file: ${err.message}`);
  }
  return null;
}

function removePidFile() {
  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch (err) {
    console.error(`Error removing PID file: ${err.message}`);
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    console.log(`No process found with PID ${pid}: ${e.message}`);
    return false;
  }
}

function startServer() {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Server is already running with PID ${existingPid}`);
    return;
  }

  console.log("Starting server...");
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(LOG_DIR, `server-${timestamp}.log`);
  
  const server = spawn("node", ["src/server.js"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  
  // Redirect stdout and stderr to log file
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  server.stdout.pipe(logStream);
  server.stderr.pipe(logStream);

  server.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  setTimeout(() => {
    if (server.pid) {
      try {
        writePid(server.pid);
        console.log(`Server started with PID ${server.pid}`);
        console.log(`Server logs are being written to: ${logFile}`);
        server.unref();
      } catch (err) {
        console.error(`Error writing PID file: ${err.message}`);
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ERROR: Error writing PID file: ${err.message}
`;
        const errorLogFile = path.join(LOG_DIR, `server-${new Date().toISOString().split("T")[0]}.error.log`);
        fs.appendFileSync(errorLogFile, logMessage);
      }
    }
    // Exit the parent process after starting the server
    process.exit(0);
  }, 1000);
}

function stopServer() {
  const pid = readPid();
  if (!pid) {
    console.log("Server is not running or PID file not found");
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log(`Server with PID ${pid} is not running`);
    removePidFile();
    return;
  }

  console.log(`Stopping server with PID ${pid}...`);
  try {
    process.kill(pid, "SIGTERM");

    // Wait a bit for graceful shutdown
    setTimeout(() => {
      if (isProcessRunning(pid)) {
        console.log("Force killing server...");
        process.kill(pid, "SIGKILL");
      }
      removePidFile();
      console.log("Server stopped");
    }, 3000);
  } catch (err) {
    console.error("Error stopping server:", err.message);
    removePidFile();
  }
}

function restartServer() {
  console.log("Restarting server...");
  stopServer();

  // Wait a bit for server to stop
  setTimeout(() => {
    startServer();
  }, 3000);
}

function checkStatus() {
  const pid = readPid();
  if (!pid) {
    console.log("Server is not running (no PID file found)");
    return;
  }

  if (isProcessRunning(pid)) {
    console.log(`Server is running with PID ${pid}`);
  } else {
    console.log(
      `Server is not running (PID ${pid} found in file but process not active)`,
    );
    removePidFile();
  }
}

switch (command) {
case "start":
  startServer();
  break;
case "stop":
  stopServer();
  break;
case "restart":
  restartServer();
  break;
case "status":
  checkStatus();
  break;
default:
  console.error(`Unknown command: ${command}`);
  console.log("Use --help for usage information");
  process.exit(1);
}

