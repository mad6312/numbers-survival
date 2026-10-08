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
let roomSettings = {
    scoreCorrection: false // 目標ポイント補正: false = なし (デフォルト), true = あり
};

let gameState = {
    inProgress: false,
    isEvaluating: false,
    initialPlayerCount: 0,
    targetScore: 0,
    scoreCorrectionApplied: false,
    requiredTraps: 0,
    numberPool: [],
    consumedNumbers: [],
    baseOrder: [],
    lastKillerId: null,
    currentKillerId: null,
    survivorOrder: [],
    roundPhase: 'waiting',
    currentSurvivorTurnIndex: 0,
    currentTraps: [],
    survivorPicks: {},
    playerStats: {},
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
        inProgress: gameState.inProgress,
        scoreCorrection: roomSettings.scoreCorrection
    });
}

function getAlivePlayersInBaseOrder() {
    return gameState.baseOrder.filter(id => players[id] && gameState.playerStats[id] && gameState.playerStats[id].alive);
}

function rotateRoles() {
    const alive = getAlivePlayersInBaseOrder();
    if (alive.length === 0) return;

    let killerIndex = 0;

    if (gameState.lastKillerId) {
        const prevIndex = alive.indexOf(gameState.lastKillerId);
        if (prevIndex !== -1) {
            killerIndex = (prevIndex + 1) % alive.length;
        } else {
            killerIndex = 0;
        }
    }

    const chosenKiller = alive[killerIndex];
    gameState.currentKillerId = chosenKiller;
    gameState.lastKillerId = chosenKiller;

    const survivors = [];
    for (let i = 1; i < alive.length; i++) {
        const sIdx = (killerIndex + i) % alive.length;
        survivors.push(alive[sIdx]);
    }

    gameState.survivorOrder = survivors;
    gameState.currentSurvivorTurnIndex = 0;
}

function calculateTargetScore(playerCount, scoreCorrectionEnabled) {
    const N = playerCount;
    if (N <= 2 || !scoreCorrectionEnabled) {
        return (N - 1) * 40;
    }
    return (N - 1) * (40 + 3 * (N - 1));
}

function startGame() {
    const readyPlayers = Object.values(players).filter(p => p.isReady);
    if (readyPlayers.length < 2 || readyPlayers.length > 10) return;

    const N = readyPlayers.length;
    gameState.inProgress = true;
    gameState.isEvaluating = false;
    gameState.initialPlayerCount = N;

    const isCorrectionActive = (roomSettings.scoreCorrection && N > 2);
    gameState.scoreCorrectionApplied = isCorrectionActive;
    gameState.targetScore = calculateTargetScore(N, roomSettings.scoreCorrection);
    gameState.requiredTraps = N - 1;

    const totalNumbers = (N - 1) * 12;
    gameState.numberPool = Array.from({ length: totalNumbers }, (_, i) => i + 1);
    gameState.consumedNumbers = [];

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
        scoreCorrectionApplied: gameState.scoreCorrectionApplied,
        requiredTraps: gameState.requiredTraps,
        numberPool: gameState.numberPool,
        consumedNumbers: gameState.consumedNumbers,
        turnOrder: gameState.baseOrder
            .filter(id => players[id]) // Unknown表示の防止（接続中のみ）
            .map(id => ({
                id,
                name: players[id].name,
                avatar: players[id].avatar,
                score: gameState.playerStats[id] ? gameState.playerStats[id].score : 0,
                life: gameState.playerStats[id] ? gameState.playerStats[id].life : 0,
                alive: gameState.playerStats[id] ? gameState.playerStats[id].alive : false
            })),
        survivorOrder: gameState.survivorOrder.filter(id => players[id]),
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
    const validSurvivors = gameState.survivorOrder.filter(id => players[id] && gameState.playerStats[id] && gameState.playerStats[id].alive);
    if (gameState.currentSurvivorTurnIndex < validSurvivors.length) {
        return validSurvivors[gameState.currentSurvivorTurnIndex];
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
        if (!players[sId]) continue; // 切断者はスキップ
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

    const rankings = gameState.baseOrder
        .filter(id => players[id])
        .map(id => ({
            id,
            name: players[id].name,
            avatar: players[id].avatar,
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

// ------------------------------
// 【重要】切断時の自動即時除外＆進行補正ロジック
// ------------------------------
function handlePlayerDisconnect(socketId) {
    const wasHost = players[socketId] ? players[socketId].isHost : false;
    delete players[socketId];

    if (wasHost) updateHost();
    syncLobbyState();

    if (!gameState.inProgress) return;

    // ゲームステートから除外
    if (gameState.playerStats[socketId]) {
        gameState.playerStats[socketId].alive = false;
    }
    gameState.baseOrder = gameState.baseOrder.filter(id => id !== socketId);
    delete gameState.survivorPicks[socketId];

    // 生存者数を再計算し、勝利判定（残り1人以下ならゲーム終了）
    const alive = getAlivePlayersInBaseOrder();
    if (alive.length <= 1) {
        endGame('survivor_last_one');
        return;
    }

    // 1. キラーが切断した場合の救済
    if (gameState.currentKillerId === socketId) {
        if (gameState.roundPhase === 'trap_setting') {
            // 罠設置中なら直ちに次のキラーへ交代してラウンド再始動
            startNewRound();
            return;
        }
    }

    // 2. サバイバーが切断した場合の救済
    if (gameState.survivorOrder.includes(socketId)) {
        gameState.survivorOrder = gameState.survivorOrder.filter(id => id !== socketId);

        if (gameState.roundPhase === 'survivor_selection') {
            // 残りサバイバーの選択完了判定
            const aliveSurvivors = gameState.survivorOrder.filter(id => players[id] && gameState.playerStats[id].alive);
            const pickedCount = Object.keys(gameState.survivorPicks).length;

            if (pickedCount >= aliveSurvivors.length && aliveSurvivors.length > 0) {
                // 全員選び終えていれば判定フェーズへ進行
                setTimeout(() => {
                    if (gameState.inProgress && !gameState.isEvaluating) {
                        evaluateRound();
                    }
                }, 800);
            } else {
                // 次のサバイバーへ手番を進める
                broadcastGameState();
            }
            return;
        }
    }

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

    socket.on('host:set_score_correction', (enabled) => {
        if (!players[socket.id] || !players[socket.id].isHost || gameState.inProgress) return;
        roomSettings.scoreCorrection = Boolean(enabled);
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

        const validSurvivors = gameState.survivorOrder.filter(id => players[id] && gameState.playerStats[id] && gameState.playerStats[id].alive);
        if (gameState.currentSurvivorTurnIndex >= validSurvivors.length) {
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

    // 切断処理（即時除外＆自律補正）
    socket.on('disconnect', () => {
        handlePlayerDisconnect(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});