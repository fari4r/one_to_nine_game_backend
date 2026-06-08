const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://soft-scone-664714.netlify.app/"],
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();
const MIN_CLICK_INTERVAL = 50;

function generateShuffledGrid() {
  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return numbers.sort(() => Math.random() - 0.5);
}

io.on("connection", (socket) => {
  // 1. Create Room (First player becomes the Host)
  socket.on("create_room", (playerName) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms.set(roomId, {
      hostId: socket.id, // Track who can start the game
      players: {
        [socket.id]: {
          name: playerName,
          nextNumber: 1,
          readyForRematch: false,
          lastClickTime: 0,
        },
      },
      grid: generateShuffledGrid(),
      gameStarted: false,
    });
    socket.join(roomId);
    socket.emit("room_created", {
      roomId,
      players: rooms.get(roomId).players,
      hostId: socket.id,
    });
  });

  // 2. Join Room (Allows multiple players)
  socket.on("join_room", ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_message", "Room not found.");
    if (room.gameStarted)
      return socket.emit("error_message", "Game already in progress.");
    if (Object.keys(room.players).length >= 8)
      return socket.emit("error_message", "Room is full (Max 8 players).");

    room.players[socket.id] = {
      name: playerName,
      nextNumber: 1,
      readyForRematch: false,
      lastClickTime: 0,
    };
    socket.join(roomId);

    io.to(roomId).emit("room_updated", {
      players: room.players,
      hostId: room.hostId,
    });
  });

  // 3. Host Starts Game Manually
  socket.on("start_game", (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || room.gameStarted) return;
    if (Object.keys(room.players).length < 2)
      return socket.emit("error_message", "Need at least 2 players to start.");

    room.gameStarted = true;
    const startTime = Date.now();
    Object.keys(room.players).forEach((id) => {
      room.players[id].lastClickTime = startTime;
      room.players[id].nextNumber = 1;
    });

    io.to(roomId).emit("game_start", {
      grid: room.grid,
      players: room.players,
    });
  });

  // 4. Handle Tile Click with Real-Time Multi-player Progression
  socket.on("tile_click", ({ roomId, clickedNumber }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameStarted) return;

    const player = room.players[socket.id];
    if (!player) return;

    const currentTime = Date.now();

    if (clickedNumber !== player.nextNumber) return;

    const timePassed = currentTime - player.lastClickTime;
    if (timePassed < MIN_CLICK_INTERVAL) {
      io.to(roomId).emit(
        "error_message",
        `${player.name} was disqualified for suspicious clicking speeds!`
      );
      delete room.players[socket.id];
      socket.leave(roomId);

      // Handle host migration if host gets kicked
      if (room.hostId === socket.id) {
        room.hostId = Object.keys(room.players)[0] || null;
      }

      if (Object.keys(room.players).length < 2) {
        room.gameStarted = false;
        io.to(roomId).emit("game_over", {
          winnerName: "Anti-Cheat / Technical Forfeit",
        });
      } else {
        io.to(roomId).emit("room_updated", {
          players: room.players,
          hostId: room.hostId,
        });
      }
      return;
    }

    player.nextNumber += 1;
    player.lastClickTime = currentTime;

    if (player.nextNumber === 10) {
      room.gameStarted = false;
      io.to(roomId).emit("game_over", {
        winnerId: socket.id,
        winnerName: player.name,
      });
    } else {
      io.to(roomId).emit("progress_update", { players: room.players });
    }
  });

  // 5. Handle Play Again (Requires everyone to opt-in)
  socket.on("play_again", (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.players[socket.id]) {
      room.players[socket.id].readyForRematch = true;
    }

    const playerIds = Object.keys(room.players);
    const allReady = playerIds.every((id) => room.players[id].readyForRematch);

    if (allReady) {
      const startTime = Date.now();
      playerIds.forEach((id) => {
        room.players[id].nextNumber = 1;
        room.players[id].readyForRematch = false;
        room.players[id].lastClickTime = startTime;
      });
      room.grid = generateShuffledGrid();
      room.gameStarted = true;

      io.to(roomId).emit("game_start", {
        grid: room.grid,
        players: room.players,
      });
    } else {
      io.to(roomId).emit("rematch_waiting", { players: room.players });
    }
  });

  // 6. Handle Leaving
  socket.on("leave_room", (roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      delete room.players[socket.id];
      socket.leave(roomId);

      if (Object.keys(room.players).length === 0) {
        rooms.delete(roomId);
      } else {
        if (room.hostId === socket.id) {
          room.hostId = Object.keys(room.players)[0]; // Migrate host permissions
        }
        io.to(roomId).emit("room_updated", {
          players: room.players,
          hostId: room.hostId,
        });

        if (room.gameStarted && Object.keys(room.players).length < 2) {
          room.gameStarted = false;
          io.to(roomId).emit("game_over", {
            winnerName: "No opponents remaining",
          });
        }
      }
    }
    socket.emit("left_room_success");
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.hostId === socket.id) {
          room.hostId = Object.keys(room.players)[0] || null;
        }

        if (Object.keys(room.players).length === 0) {
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit("room_updated", {
            players: room.players,
            hostId: room.hostId,
          });
          if (room.gameStarted && Object.keys(room.players).length < 2) {
            room.gameStarted = false;
            io.to(roomId).emit("game_over", {
              winnerName: "Opponents disconnected",
            });
          }
        }
      }
    }
  });
});

server.listen(3001, () =>
  console.log("MULTIPLAYER SERVER RUNNING ON PORT 3001")
);
