const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// サーバー全体の管理ステート
const players = {}; // socketId -> { id, name, avatar, isReady, isHost }
let gameState = {
    inProgress: false,
    isEvaluating: false,
    initialPlayerCount: 0,
    targetScore: 0,
    requiredTraps: 0,
    numberPool: [],         // [1, 2, ...]
    consumedNumbers: [],
    baseOrder: [],          // 【重要】ゲーム開始時に固定された基本順序 [socketId, ...]
    lastKillerId: null,     // 前ラウンドのキラーID（ローテーション追跡用）
    currentKillerId: null,
    survivorOrder: [],      // 現ラウンドのサバイバー行動順（時計回り）
    roundPhase: 'waiting',  // 'trap_setting', 'survivor_selection', 'evaluating', 'round_end', 'game_over'
    currentSurvivorTurnIndex: 0,
    currentTraps: [],
    survivorPicks: {},      // socketId -> number
    playerStats: {},        // socketId -> { score, life, alive }
    roundResults: null
};

const DEFAULT_AVATARS = ['🤖', '🐱', '🦊', '🦁', '🐼', '🐨', '🐯', '🐰', '🦄', '🐲'];

function getConnectedList() {
    return Object.values(players).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isReady: p.isReady,
        isHost: p.isHost
    }));
}

function updateHost() {
    const ids = Object.keys(players);
    if (ids.length === 0) return;
    const currentHost = ids.find(id => players[id].isHost);
    if (!currentHost) {
        players[ids[0]].isHost = true;
    }
}

function syncLobbyState() {
    io.emit('lobby:update', {
        players: getConnectedList(),
        inProgress: gameState.inProgress
    });
}

// 基本順序に基づいた生存プレイヤーリストを取得（脱落者は除外）
function getAlivePlayersInBaseOrder() {
    return gameState.baseOrder.filter(id => gameState.playerStats[id] && gameState.playerStats[id].alive);
}

// キラー交代およびサバイバー時計回り順序決定ロジック
function rotateRoles() {
    const alive = getAlivePlayersInBaseOrder();
    if (alive.length === 0) return;

    let killerIndex = 0;

    // 初回ラウンドでない場合は、前回キラーの次の生存者をキラーに選出
    if (gameState.lastKillerId) {
        const prevIndex = alive.indexOf(gameState.lastKillerId);
        if (prevIndex !== -1) {
            killerIndex = (prevIndex + 1) % alive.length;
        } else {
            // 前回キラーが脱落していた場合はそのまま現在のインデックス位置をキラーに
            killerIndex = 0;
        }
    }

    const chosenKiller = alive[killerIndex];
    gameState.currentKillerId = chosenKiller;
    gameState.lastKillerId = chosenKiller;

    // サバイバーの行動順: キラーの直後から時計回りに生存者を配置
    const survivors = [];
    for (let i = 1; i < alive.length; i++) {
        const sIdx = (killerIndex + i) % alive.length;
        survivors.push(alive[sIdx]);
    }

    gameState.survivorOrder = survivors;
    gameState.currentSurvivorTurnIndex = 0;
}

function startGame() {
    const readyPlayers = Object.values(players).filter(p => p.isReady);
    if (readyPlayers.length < 2 || readyPlayers.length > 10) return;

    const N = readyPlayers.length;
    gameState.inProgress = true;
    gameState.isEvaluating = false;
    gameState.initialPlayerCount = N;
    gameState.targetScore = (N - 1) * 40;
    gameState.requiredTraps = N - 1;

    const totalNumbers = (N - 1) * 12;
    gameState.numberPool = Array.from({ length: totalNumbers }, (_, i) => i + 1);
    gameState.consumedNumbers = [];

    // 【仕様変更】ゲーム開始時に全参加者の行動順をランダム決定し固定
    gameState.baseOrder = readyPlayers.map(p => p.id).sort(() => Math.random() - 0.5);
    gameState.lastKillerId = null;

    gameState.playerStats = {};
    readyPlayers.forEach(p => {
        gameState.playerStats[p.id] = {
            score: 0,
            life: 3,
            alive: true
        };
    });

    startNewRound();
}

function startNewRound() {
    gameState.isEvaluating = false;
    const alive = getAlivePlayersInBaseOrder();

    if (alive.length <= 1) {
        endGame('survivor_last_one');
        return;
    }

    if (gameState.numberPool.length <= gameState.requiredTraps) {
        endGame('pool_exhausted');
        return;
    }

    // キラーの時計回り選出 ＆ サバイバー行動順の時計回り決定
    rotateRoles();

    gameState.currentTraps = [];
    gameState.survivorPicks = {};
    gameState.roundPhase = 'trap_setting';
    gameState.roundResults = null;

    broadcastGameState();
}

function getPublicGameState(forSocketId) {
    const isKiller = (forSocketId === gameState.currentKillerId);

    return {
        inProgress: gameState.inProgress,
        initialPlayerCount: gameState.initialPlayerCount,
        targetScore: gameState.targetScore,
        requiredTraps: gameState.requiredTraps,
        numberPool: gameState.numberPool,
        consumedNumbers: gameState.consumedNumbers,
        turnOrder: gameState.baseOrder.map(id => ({
            id,
            name: players[id] ? players[id].name : 'Unknown',
            avatar: players[id] ? players[id].avatar : '❓',
            score: gameState.playerStats[id] ? gameState.playerStats[id].score : 0,
            life: gameState.playerStats[id] ? gameState.playerStats[id].life : 0,
            alive: gameState.playerStats[id] ? gameState.playerStats[id].alive : false
        })),
        survivorOrder: gameState.survivorOrder,
        currentKillerId: gameState.currentKillerId,
        roundPhase: gameState.roundPhase,
        trapsSetCount: gameState.currentTraps.length,
        myTraps: isKiller ? gameState.currentTraps : [],
        survivorPicks: gameState.survivorPicks,
        currentSurvivorId: getCurrentSurvivorId(),
        roundResults: gameState.roundResults
    };
}

function getCurrentSurvivorId() {
    if (gameState.roundPhase !== 'survivor_selection') return null;
    if (gameState.currentSurvivorTurnIndex < gameState.survivorOrder.length) {
        return gameState.survivorOrder[gameState.currentSurvivorTurnIndex];
    }
    return null;
}

function broadcastGameState() {
    for (const socketId of Object.keys(players)) {
        io.to(socketId).emit('game:update', getPublicGameState(socketId));
    }
}

function evaluateRound() {
    if (gameState.isEvaluating) return;
    gameState.isEvaluating = true;
    gameState.roundPhase = 'evaluating';

    const results = {};
    const traps = gameState.currentTraps;
    const pickedSafeNumbers = [];

    for (const [sId, pickedNum] of Object.entries(gameState.survivorPicks)) {
        const isOut = traps.includes(pickedNum);
        if (isOut) {
            gameState.playerStats[sId].score = 0;
            gameState.playerStats[sId].life -= 1;
            if (gameState.playerStats[sId].life <= 0) {
                gameState.playerStats[sId].alive = false;
            }
            results[sId] = { result: 'Out', number: pickedNum, pointsEarned: 0 };
        } else {
            gameState.playerStats[sId].score += pickedNum;
            pickedSafeNumbers.push(pickedNum);
            results[sId] = { result: 'Safe', number: pickedNum, pointsEarned: pickedNum };
        }
    }

    gameState.numberPool = gameState.numberPool.filter(n => !pickedSafeNumbers.includes(n));
    gameState.consumedNumbers.push(...pickedSafeNumbers);

    gameState.roundResults = {
        results,
        trapsRevealed: [...gameState.currentTraps]
    };

    io.emit('game:round_evaluating', {
        countdown: 3,
        results: gameState.roundResults
    });

    setTimeout(() => {
        let winnerDeclared = checkWinConditions();
        if (!winnerDeclared) {
            startNewRound();
        }
    }, 8800);
}

function checkWinConditions() {
    const alive = getAlivePlayersInBaseOrder();

    if (alive.filter(id => gameState.playerStats[id].score >= gameState.targetScore).length > 0) {
        endGame('target_reached');
        return true;
    }
    if (alive.length <= 1) {
        endGame('survivor_last_one');
        return true;
    }
    if (gameState.numberPool.length <= gameState.requiredTraps) {
        endGame('pool_exhausted');
        return true;
    }
    return false;
}

function endGame(reason) {
    gameState.inProgress = false;
    gameState.isEvaluating = false;
    gameState.roundPhase = 'game_over';

    const rankings = gameState.baseOrder.map(id => ({
        id,
        name: players[id] ? players[id].name : 'Unknown',
        avatar: players[id] ? players[id].avatar : '❓',
        score: gameState.playerStats[id] ? gameState.playerStats[id].score : 0,
        life: gameState.playerStats[id] ? gameState.playerStats[id].life : 0,
        alive: gameState.playerStats[id] ? gameState.playerStats[id].alive : false
    })).sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        return b.score - a.score;
    });

    io.emit('game:over', { reason, rankings });
    broadcastGameState();
}

io.on('connection', (socket) => {
    const defaultAvatar = DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)];
    players[socket.id] = {
        id: socket.id,
        name: `Player_${socket.id.substring(0, 4)}`,
        avatar: defaultAvatar,
        isReady: false,
        isHost: false
    };

    updateHost();
    syncLobbyState();

    socket.on('player:update_profile', ({ name, avatar }) => {
        if (!players[socket.id]) return;
        if (name && typeof name === 'string') players[socket.id].name = name.trim().slice(0, 10);
        if (avatar && typeof avatar === 'string') players[socket.id].avatar = avatar;
        syncLobbyState();
        if (gameState.inProgress) broadcastGameState();
    });

    socket.on('lobby:toggle_ready', () => {
        if (!players[socket.id] || gameState.inProgress) return;
        players[socket.id].isReady = !players[socket.id].isReady;
        syncLobbyState();
    });

    socket.on('game:start', () => {
        if (!players[socket.id] || !players[socket.id].isHost) return;
        const readyCount = Object.values(players).filter(p => p.isReady).length;
        if (readyCount >= 2 && readyCount <= 10) {
            startGame();
        }
    });

    socket.on('game:set_traps', (trapNumbers) => {
        if (!gameState.inProgress || gameState.roundPhase !== 'trap_setting') return;
        if (socket.id !== gameState.currentKillerId) return;
        if (!Array.isArray(trapNumbers) || trapNumbers.length !== gameState.requiredTraps) return;
        if (!trapNumbers.every(n => gameState.numberPool.includes(n))) return;

        gameState.currentTraps = trapNumbers;
        gameState.roundPhase = 'survivor_selection';
        gameState.currentSurvivorTurnIndex = 0;
        gameState.survivorPicks = {};

        broadcastGameState();
    });

    socket.on('game:pick_number', (number) => {
        if (!gameState.inProgress || gameState.roundPhase !== 'survivor_selection') return;
        if (gameState.isEvaluating) return;
        const currentSurvivorId = getCurrentSurvivorId();
        if (socket.id !== currentSurvivorId) return;

        if (!gameState.numberPool.includes(number)) return;
        if (Object.values(gameState.survivorPicks).includes(number)) return;

        gameState.survivorPicks[socket.id] = number;
        gameState.currentSurvivorTurnIndex += 1;

        broadcastGameState();

        if (gameState.currentSurvivorTurnIndex >= gameState.survivorOrder.length) {
            setTimeout(() => {
                if (gameState.inProgress && !gameState.isEvaluating) {
                    evaluateRound();
                }
            }, 800);
        }
    });

    socket.on('game:rematch_entry', () => {
        if (!players[socket.id]) return;
        players[socket.id].isReady = true;
        syncLobbyState();
        socket.emit('game:rematch_confirmed');
    });

    socket.on('game:leave', () => {
        if (!players[socket.id]) return;
        players[socket.id].isReady = false;
        syncLobbyState();
        socket.emit('game:leave_confirmed');
    });

    socket.on('disconnect', () => {
        const wasHost = players[socket.id] ? players[socket.id].isHost : false;
        delete players[socket.id];

        if (wasHost) updateHost();
        syncLobbyState();

        if (gameState.inProgress) {
            if (gameState.playerStats[socket.id]) {
                gameState.playerStats[socket.id].alive = false;
            }
            checkWinConditions();
            broadcastGameState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});