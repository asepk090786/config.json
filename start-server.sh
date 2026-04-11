#!/usr/bin/env bash
cd "$(dirname "$0")"

# start server.js in background and save pid
nohup npm start > server.log 2>&1 &
PID=$!
echo $PID > server.pid
printf "Server started with PID %s\n" "$PID"
