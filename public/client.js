const socket = io();

// プリセットアバター
const AVATAR_PRESETS = ['🤖', '🐱', '🦊', '🦁', '🐼', '🐨', '🐯', '🐰', '🦄', '🐲'];

// ローカル状態
let myProfile = {
    name: '',
    avatar: '🤖'
};
let selectedAvatarForSetting = '🤖';
let selectedTraps = [];
let lastGameState = null;
let evalIntervalTimer = null;
let evalResetTimeout = null;

// DOM 要素
const lobbyView = document.getElementById('lobby-view');
const gameView = document.getElementById('game-view');
const readyCountBadge = document.getElementById('ready-count-badge');
const lobbyPlayersList = document.getElementById('lobby-players-list');
const toggleReadyBtn = document.getElementById('toggle-ready-btn');
const startGameBtn = document.getElementById('start-game-btn');
const hostHint = document.getElementById('host-hint');

// ゲームUI
const opponentsContainer = document.getElementById('opponents-container');
const roundPhaseText = document.getElementById('round-phase-text');
const gameGoals = document.getElementById('game-goals');
const numberPoolEl = document.getElementById('number-pool');
const killerActionBar = document.getElementById('killer-action-bar');
const submitTrapsBtn = document.getElementById('submit-traps-btn');
const trapsNeededEl = document.getElementById('traps-needed');

// 自陣UI
const myStatusBox = document.getElementById('my-status-box');
const myAvatarDisplay = document.getElementById('my-avatar-display');
const myNameDisplay = document.getElementById('my-name-display');
const myRoleBadge = document.getElementById('my-role-badge');
const myLifeDisplay = document.getElementById('my-life-display');
const myScoreDisplay = document.getElementById('my-score-display');

// カウントダウン演出UI
const evalOverlay = document.getElementById('evaluation-overlay');
const evalCountdown = document.getElementById('eval-countdown');
const evalResultCard = document.getElementById('eval-result-card');
const evalTitle = document.getElementById('eval-title');
const evalSubtext = document.getElementById('eval-subtext');

// モーダル
const gameOverModal = document.getElementById('game-over-modal');
const gameOverReason = document.getElementById('game-over-reason');
const rankingsTbody = document.getElementById('rankings-tbody');
const rematchBtn = document.getElementById('rematch-btn');
const leaveBtn = document.getElementById('leave-btn');

const settingsModal = document.getElementById('settings-modal');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingPlayerName = document.getElementById('setting-player-name');
const avatarPresets = document.getElementById('avatar-presets');

function formatLife(life) {
    const current = Math.max(0, Math.min(3, life));
    return '♥'.repeat(current) + '♡'.repeat(3 - current);
}

// ------------------------------
// 設定モーダル
// ------------------------------
function initSettings() {
    avatarPresets.innerHTML = '';
    AVATAR_PRESETS.forEach(avatar => {
        const div = document.createElement('div');
        div.className = 'avatar-opt';
        div.textContent = avatar;
        div.addEventListener('click', () => {
            document.querySelectorAll('.avatar-opt').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
            selectedAvatarForSetting = avatar;
        });
        avatarPresets.appendChild(div);
    });

    openSettingsBtn.addEventListener('click', () => {
        settingPlayerName.value = myProfile.name;
        selectedAvatarForSetting = myProfile.avatar;
        document.querySelectorAll('.avatar-opt').forEach(el => {
            el.classList.toggle('selected', el.textContent === selectedAvatarForSetting);
        });
        settingsModal.classList.remove('hidden');
    });

    closeSettingsBtn.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });

    saveSettingsBtn.addEventListener('click', () => {
        const newName = settingPlayerName.value.trim();
        if (newName) {
            myProfile.name = newName;
            myProfile.avatar = selectedAvatarForSetting;
            socket.emit('player:update_profile', {
                name: myProfile.name,
                avatar: myProfile.avatar
            });
            settingsModal.classList.add('hidden');
        }
    });
}
initSettings();

// ------------------------------
// ロビー操作
// ------------------------------
toggleReadyBtn.addEventListener('click', () => {
    socket.emit('lobby:toggle_ready');
});

startGameBtn.addEventListener('click', () => {
    socket.emit('game:start');
});

socket.on('lobby:update', ({ players, inProgress }) => {
    const me = players.find(p => p.id === socket.id);
    if (me) {
        if (!myProfile.name) myProfile.name = me.name;
        myProfile.avatar = me.avatar;

        if (me.isReady) {
            toggleReadyBtn.textContent = '参加キャンセル';
            toggleReadyBtn.classList.add('ready-active');
        } else {
            toggleReadyBtn.textContent = '参加する';
            toggleReadyBtn.classList.remove('ready-active');
        }

        if (me.isHost) {
            startGameBtn.style.display = 'inline-block';
            const readyPlayers = players.filter(p => p.isReady).length;
            if (readyPlayers >= 2 && readyPlayers <= 10) {
                startGameBtn.removeAttribute('disabled');
                hostHint.textContent = 'ゲームを開始できます';
            } else {
                startGameBtn.setAttribute('disabled', 'true');
                hostHint.textContent = '開始には2〜10名のエントリーが必要です';
            }
        } else {
            startGameBtn.style.display = 'none';
            hostHint.textContent = 'ホストがゲームを開始するのをお待ちください';
        }
    }

    const readyCount = players.filter(p => p.isReady).length;
    readyCountBadge.textContent = `${readyCount} / ${players.length}`;

    lobbyPlayersList.innerHTML = '';
    players.forEach(p => {
        const card = document.createElement('div');
        card.className = `lobby-player-chip ${p.isReady ? 'ready' : ''} ${p.isHost ? 'is-host' : ''}`;
        card.innerHTML = `
      <div class="chip-avatar">${p.avatar}</div>
      <div class="chip-name">${p.name}</div>
      <div class="chip-status">${p.isReady ? '参加中...' : '待機中'}</div>
    `;
        lobbyPlayersList.appendChild(card);
    });

    if (!inProgress) {
        lobbyView.classList.add('active');
        gameView.classList.remove('active');
    }
});

// ------------------------------
// ゲーム盤面描画
// ------------------------------
socket.on('game:update', (state) => {
    lastGameState = state;
    lobbyView.classList.remove('active');
    gameView.classList.add('active');

    const myId = socket.id;
    const isKiller = (state.currentKillerId === myId);
    const myPlayer = state.turnOrder.find(p => p.id === myId);
    const isMySurvivorTurn = (state.roundPhase === 'survivor_selection' && state.currentSurvivorId === myId);

    // 1. 自陣情報の描画
    if (myPlayer) {
        myAvatarDisplay.textContent = myPlayer.avatar;
        myNameDisplay.textContent = myPlayer.name;
        myLifeDisplay.textContent = formatLife(myPlayer.life);
        myScoreDisplay.textContent = myPlayer.score;

        if (isMySurvivorTurn) {
            myStatusBox.classList.add('is-active-turn');
        } else {
            myStatusBox.classList.remove('is-active-turn');
        }

        if (isKiller) {
            myRoleBadge.textContent = 'キラー';
            myRoleBadge.className = 'role-badge killer';
            myStatusBox.classList.add('is-killer');
        } else {
            myRoleBadge.textContent = isMySurvivorTurn ? 'あなたの番！' : 'サバイバー';
            myRoleBadge.className = isMySurvivorTurn ? 'role-badge turn-active' : 'role-badge';
            myStatusBox.classList.remove('is-killer');
        }
    }

    // 2. 対戦相手カードの描画
    opponentsContainer.innerHTML = '';
    state.turnOrder.forEach(p => {
        if (p.id === myId) return;
        const isOppKiller = (p.id === state.currentKillerId);
        const isOppActiveTurn = (state.roundPhase === 'survivor_selection' && state.currentSurvivorId === p.id);

        const card = document.createElement('div');
        card.id = `player-card-${p.id}`;
        card.className = `opponent-card ${!p.alive ? 'dead' : ''} ${isOppKiller ? 'is-killer' : ''} ${isOppActiveTurn ? 'is-active-turn' : ''}`;

        card.innerHTML = `
      <div class="opp-avatar">${p.avatar}</div>
      <div class="opp-details">
        <div class="opp-name-box">
          <span class="opp-name">${p.name}</span>
          ${isOppKiller ? '<span class="role-badge killer">キラー</span>' : ''}
          ${isOppActiveTurn ? '<span class="role-badge turn-active">選択中</span>' : ''}
        </div>
        <div class="opp-stats">
          <span class="heart-text">${formatLife(p.life)}</span> | <span class="score-text">${p.score}pt</span>
        </div>
      </div>
    `;
        opponentsContainer.appendChild(card);
    });

    gameGoals.textContent = `目標スコア: ${state.targetScore}pt | 罠: ${state.requiredTraps}個`;

    trapsNeededEl.textContent = state.requiredTraps;
    if (state.roundPhase === 'trap_setting') {
        if (isKiller) {
            roundPhaseText.textContent = `【あなたの番】罠を ${state.requiredTraps} 個選択して仕掛けてください`;
            killerActionBar.style.display = 'flex';
            updateKillerButtonState();
        } else {
            roundPhaseText.textContent = 'キラーが罠を設置しています...お待ちください';
            killerActionBar.style.display = 'none';
        }
    } else if (state.roundPhase === 'survivor_selection') {
        killerActionBar.style.display = 'none';
        if (state.currentSurvivorId === myId) {
            roundPhaseText.textContent = '【あなたの番】数字を1つクリックして回避してください！';
        } else {
            const activeSurvivor = state.turnOrder.find(p => p.id === state.currentSurvivorId);
            const name = activeSurvivor ? activeSurvivor.name : '相手';
            roundPhaseText.textContent = `${name} が数字を選択中...`;
        }
    } else if (state.roundPhase === 'evaluating') {
        roundPhaseText.textContent = '運命の判定中...';
        killerActionBar.style.display = 'none';
    }

    renderNumberPool(state);
});

// ------------------------------
// 数字プール描画 ＆ アバターバッジ・ツールチップ
// ------------------------------
function renderNumberPool(state) {
    numberPoolEl.innerHTML = '';
    const myId = socket.id;
    const isKiller = (state.currentKillerId === myId);
    const isMySurvivorTurn = (state.roundPhase === 'survivor_selection' && state.currentSurvivorId === myId);

    const allNumbers = [...new Set([...state.numberPool, ...state.consumedNumbers])].sort((a, b) => a - b);

    allNumbers.forEach(num => {
        const isConsumed = state.consumedNumbers.includes(num);
        const card = document.createElement('div');
        card.className = 'num-card';
        card.textContent = num;

        if (isConsumed) {
            card.classList.add('consumed');
        } else {
            for (const [pickerId, pickedNum] of Object.entries(state.survivorPicks)) {
                if (pickedNum === num) {
                    const picker = state.turnOrder.find(p => p.id === pickerId);
                    if (picker) {
                        const badge = document.createElement('span');
                        badge.className = 'picked-avatar-badge';
                        badge.textContent = picker.avatar;
                        badge.setAttribute('data-tooltip', picker.name);
                        card.appendChild(badge);
                    }
                    if (pickerId === myId) card.classList.add('selected-by-me');
                    card.classList.add('disabled');
                }
            }

            if (isKiller && (selectedTraps.includes(num) || state.myTraps.includes(num))) {
                card.classList.add('trap-selected');
            }

            card.addEventListener('click', () => {
                if (state.roundPhase === 'trap_setting' && isKiller) {
                    if (selectedTraps.includes(num)) {
                        selectedTraps = selectedTraps.filter(n => n !== num);
                    } else {
                        if (selectedTraps.length < state.requiredTraps) {
                            selectedTraps.push(num);
                        }
                    }
                    updateKillerButtonState();
                    renderNumberPool(lastGameState);
                } else if (isMySurvivorTurn) {
                    if (!Object.values(state.survivorPicks).includes(num)) {
                        socket.emit('game:pick_number', num);
                    }
                }
            });
        }

        numberPoolEl.appendChild(card);
    });
}

function updateKillerButtonState() {
    if (!lastGameState) return;
    const needed = lastGameState.requiredTraps;
    submitTrapsBtn.textContent = `罠を設置する (${selectedTraps.length}/${needed})`;
    if (selectedTraps.length === needed) {
        submitTrapsBtn.removeAttribute('disabled');
    } else {
        submitTrapsBtn.setAttribute('disabled', 'true');
    }
}

submitTrapsBtn.addEventListener('click', () => {
    if (selectedTraps.length === lastGameState.requiredTraps) {
        socket.emit('game:set_traps', selectedTraps);
        selectedTraps = [];
    }
});

// ------------------------------
// ラウンド判定カウントダウン＆演出
// ------------------------------
function triggerCountAnimation(number) {
    evalCountdown.textContent = number;
    evalCountdown.classList.remove('pulse-once');
    void evalCountdown.offsetWidth;
    evalCountdown.classList.add('pulse-once');
}

socket.on('game:round_evaluating', ({ countdown, results }) => {
    if (evalIntervalTimer) clearInterval(evalIntervalTimer);
    if (evalResetTimeout) clearTimeout(evalResetTimeout);

    // カウントダウン開始時に手番強調および既存の判定バッジをリセット
    document.querySelectorAll('.is-active-turn').forEach(el => el.classList.remove('is-active-turn'));
    document.querySelectorAll('.floating-result-badge').forEach(el => el.remove());
    if (myRoleBadge && !myStatusBox.classList.contains('is-killer')) {
        myRoleBadge.textContent = 'サバイバー';
        myRoleBadge.className = 'role-badge';
    }
    document.querySelectorAll('.opponent-card .turn-active').forEach(el => el.remove());

    evalOverlay.classList.remove('hidden');
    evalResultCard.classList.add('hidden');
    evalCountdown.classList.remove('hidden');

    let currentSec = countdown;
    triggerCountAnimation(currentSec);

    evalIntervalTimer = setInterval(() => {
        currentSec--;
        if (currentSec > 0) {
            triggerCountAnimation(currentSec);
        } else {
            clearInterval(evalIntervalTimer);
            evalIntervalTimer = null;
            evalCountdown.classList.add('hidden');
            showResultDetails(results);
        }
    }, 1000);
});

function showResultDetails(roundResults) {
    const myId = socket.id;
    const myRes = roundResults.results[myId];

    // 枠線の色変更 ＆ 各サバイバー枠上部に「SAFE」「OUT」バッジを表示
    for (const [pId, res] of Object.entries(roundResults.results)) {
        const isSafe = (res.result === 'Safe');
        const badgeText = isSafe ? 'SAFE' : 'OUT';
        const badgeClass = isSafe ? 'badge-safe' : 'badge-out';

        // 1. 対戦相手カードへの適用
        const card = document.getElementById(`player-card-${pId}`);
        if (card) {
            card.classList.add(isSafe ? 'result-safe' : 'result-out');
            const badge = document.createElement('div');
            badge.className = `floating-result-badge ${badgeClass}`;
            badge.textContent = badgeText;
            card.appendChild(badge);
        }

        // 2. 自陣枠への適用
        if (pId === myId) {
            myStatusBox.classList.add(isSafe ? 'result-safe' : 'result-out');
            const badge = document.createElement('div');
            badge.className = `floating-result-badge ${badgeClass}`;
            badge.textContent = badgeText;
            myStatusBox.appendChild(badge);
        }
    }

    // 自身がサバイバーなら中央結果カードを表示
    if (myRes) {
        evalResultCard.classList.remove('hidden');
        if (myRes.result === 'Safe') {
            evalTitle.textContent = 'Safe';
            evalTitle.className = 'eval-title safe';
            evalSubtext.textContent = `+${myRes.pointsEarned} pts 獲得！`;
        } else {
            evalTitle.textContent = 'Out';
            evalTitle.className = 'eval-title out';
            evalSubtext.textContent = 'ポイント全額没収 & ライフ消費！';
        }
    }

    // 3.5秒後に演出を消去し、枠色および上部バッジをリセット
    evalResetTimeout = setTimeout(() => {
        evalOverlay.classList.add('hidden');
        evalResultCard.classList.add('hidden');
        document.querySelectorAll('.result-safe').forEach(el => el.classList.remove('result-safe'));
        document.querySelectorAll('.result-out').forEach(el => el.classList.remove('result-out'));
        document.querySelectorAll('.floating-result-badge').forEach(el => el.remove());
    }, 3500);
}

// ------------------------------
// ゲーム終了・モーダル
// ------------------------------
socket.on('game:over', ({ reason, rankings }) => {
    if (evalIntervalTimer) clearInterval(evalIntervalTimer);
    if (evalResetTimeout) clearTimeout(evalResetTimeout);
    evalOverlay.classList.add('hidden');
    document.querySelectorAll('.floating-result-badge').forEach(el => el.remove());

    let reasonText = '';
    switch (reason) {
        case 'target_reached':
            reasonText = '🏆 目標ポイント到達！勝者が決定しました！';
            break;
        case 'survivor_last_one':
            reasonText = '💀 他プレイヤーが全滅！最後の生存者の勝利！';
            break;
        case 'pool_exhausted':
            reasonText = '📦 数字プールが枯渇！最終スコア集計！';
            break;
        default:
            reasonText = 'ゲーム終了！';
    }
    gameOverReason.textContent = reasonText;

    rankingsTbody.innerHTML = '';
    rankings.forEach((p, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td><strong>${idx + 1}位</strong></td>
      <td>${p.avatar} ${p.name}</td>
      <td class="heart-text">${formatLife(p.life)}</td>
      <td class="score-text">${p.score} pt</td>
    `;
        rankingsTbody.appendChild(tr);
    });

    gameOverModal.classList.remove('hidden');
});

// 再戦・退出
rematchBtn.addEventListener('click', () => {
    socket.emit('game:rematch_entry');
});

socket.on('game:rematch_confirmed', () => {
    gameOverModal.classList.add('hidden');
    gameView.classList.remove('active');
    lobbyView.classList.add('active');
});

leaveBtn.addEventListener('click', () => {
    socket.emit('game:leave');
});

socket.on('game:leave_confirmed', () => {
    gameOverModal.classList.add('hidden');
    gameView.classList.remove('active');
    lobbyView.classList.add('active');
});