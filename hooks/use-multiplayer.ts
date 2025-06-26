"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { GameStore } from "@/lib/game-store"
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/supabase"

interface Room {
  id: string
  players: Player[]
  settings: {
    totalPlayers: number
    imposterCount: number
    difficulty: "easy" | "medium" | "hard"
    roundTime: number
  }
  game_phase: "lobby" | "starting" | "clues" | "voting" | "results" | "reveal_votes"
  current_player_index: number
  time_left: number
  round: number
  eliminationResult: string | null
  gameWinner: 'majority' | 'imposters' | null
  lastEliminatedPlayerId: string | null
  voteCounts: Record<string, number> | null;
}

interface Player {
  id: string
  name: string
  is_admin: boolean
  word?: string
  clue?: string
  votes: number
  is_eliminated?: boolean
  has_voted?: boolean
  has_submitted_clue?: boolean;
}

export function useMultiplayer(roomCode: string, playerName: string, isAdmin: boolean) {
  const [room, setRoom] = useState<Room | null>(null)
  const [playerId, setPlayerId] = useState<string>("")
  const [error, setError] = useState<string>("")
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(true)
  const [backendType, setBackendType] = useState<string>("Loading...")
  const [subscription, setSubscription] = useState<any>(null)
  const connectionAttempted = useRef(false)
  const heartbeatInterval = useRef<NodeJS.Timeout | null>(null)
  const pollingInterval = useRef<NodeJS.Timeout | null>(null)
  const heartbeatFailures = useRef(0)
  let isMounted = true

  useEffect(() => {
    if (connectionAttempted.current) {
      return
    }
    connectionAttempted.current = true

    const connectToRoom = async () => {
      try {
        setBackendType(GameStore.getBackendType())
        setIsConnecting(true)
        setError("")
        let result
        if (isAdmin) {
          const existingRoom = await GameStore.getRoom(roomCode)
          if (existingRoom) {
            const adminPlayer = existingRoom.players.find(
              (p) => p.is_admin && p.name.toLowerCase() === playerName.toLowerCase(),
            )
            if (adminPlayer) {
              result = { room: existingRoom, playerId: adminPlayer.id }
            } else {
              throw new Error("Room code already exists with different admin")
            }
          } else {
            throw new Error("Room not found after creation")
          }
        } else {
          result = await GameStore.joinRoom(roomCode, playerName)
        }

        if (!result) {
          throw new Error(isAdmin ? "Failed to connect to room" : "Failed to join room")
        }

        if (isMounted) {
          setRoom(result.room)
          setPlayerId(result.playerId)
          setIsConnected(true)
          heartbeatInterval.current = setInterval(async () => {
            if (result.playerId && isMounted) {
              const success = await GameStore.heartbeat(result.playerId)
              if (!success) {
                heartbeatFailures.current++
                if (heartbeatFailures.current >= 3) {
                  setError("Connection lost (heartbeat). Please try reconnecting.")
                  setIsConnected(false)
                  if (heartbeatInterval.current) clearInterval(heartbeatInterval.current)
                  if (pollingInterval.current) clearInterval(pollingInterval.current)
                }
              } else {
                heartbeatFailures.current = 0
              }
            }
          }, 30000)

          if (isSupabaseConfigured()) {
            try {
              const supabase = getSupabaseClient()
              const newSubscription = supabase
                .channel(`room:${roomCode}`)
                .on(
                  "postgres_changes",
                  { event: "*", schema: "public", table: "game_rooms", filter: `id=eq.${roomCode.toUpperCase()}`},
                  async () => {
                    const updatedRoom = await GameStore.getRoom(roomCode);
                    if (isMounted && updatedRoom) setRoom(updatedRoom);
                  }
                )
                .on(
                  "postgres_changes",
                  { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomCode.toUpperCase()}`},
                  async () => {
                    const updatedRoom = await GameStore.getRoom(roomCode);
                    if (isMounted && updatedRoom) setRoom(updatedRoom);
                  }
                )
                .subscribe((status) => {
                  if (status === "CHANNEL_ERROR") {
                    setError("Real-time connection issue. Switched to fallback mode (slower updates).")
                    setupPolling()
                  }
                })
              setSubscription(newSubscription)
            } catch (subscriptionError) {
              setupPolling()
            }
          } else {
            setupPolling()
          }
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to connect to room")
          setIsConnected(false)
        }
      } finally {
        if (isMounted) setIsConnecting(false)
      }
    }
    connectToRoom()
    return () => {
      isMounted = false
      if (pollingInterval.current) clearInterval(pollingInterval.current)
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current)
      if (subscription) subscription.unsubscribe()
    }
  }, [roomCode, playerName, isAdmin])

  const setupPolling = () => {
    pollingInterval.current = setInterval(async () => {
      try {
        const updatedRoom = await GameStore.getRoom(roomCode)
        if (isMounted) {
          if (updatedRoom) {
            if (!room || JSON.stringify(room.players) !== JSON.stringify(updatedRoom.players) || room.game_phase !== updatedRoom.game_phase ) {
              setRoom(updatedRoom)
            }
          } else if (isConnected) {
            setError("Room no longer exists")
            setIsConnected(false)
          }
        }
      } catch (err) { console.error("Polling error:", err) }
    }, 1000)
  }

  const updateSettings = useCallback( async (settings: Partial<Room["settings"]>) => {
      if (!room || !isConnected) return false
      try {
        const updatedRoom = await GameStore.updateRoom(roomCode, { settings: { ...room.settings, ...settings } } as any)
        if (updatedRoom) { setRoom(updatedRoom); return true }
        return false
      } catch (err) { console.error("Failed to update settings:", err); return false }
    }, [room, isConnected, roomCode]);

  const startGame = useCallback(async () => {
    if (!room || !isConnected || room.players.length < 2) {
      if(room && room.players.length < 2) setError("At least 2 players are required.");
      return false;
    }
    try {
      const { majorityWord, imposterWord } = generateWords(room.settings.difficulty);
      const playerCount = room.players.length;
      const imposterCount = Math.min(room.settings.imposterCount, Math.floor(playerCount / 2));
      const indices = Array.from({ length: playerCount }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const imposterIndices = indices.slice(0, imposterCount);
      for (let i = 0; i < room.players.length; i++) {
        const player = room.players[i];
        const isImposter = imposterIndices.includes(i);
        await GameStore.updatePlayer(roomCode, player.id, {
          word: isImposter ? imposterWord : majorityWord,
          clue: "", votes: 0, is_eliminated: false, has_submitted_clue: false, has_voted: false,
        });
      }
      await GameStore.updateRoom(roomCode, {
        game_phase: "starting", time_left: 5, current_player_index: 0, round: 1,
        eliminationResult: null, gameWinner: null, lastEliminatedPlayerId: null, voteCounts: null,
      } as any);
      if (isAdmin) {
        setTimeout(async () => {
          const currentRoom = await GameStore.getRoom(roomCode);
          if (currentRoom && currentRoom.game_phase === "starting") {
            await GameStore.updateRoom(roomCode, { game_phase: "simultaneous_clues", time_left: 20 } as any);
          }
        }, 5000);
      }
      return true;
    } catch (err) { console.error("Failed to start game:", err); setError("Failed to start game."); return false; }
  }, [room, isConnected, roomCode, isAdmin]);

  const submitClue = useCallback( async (clue: string) => {
    if (!room || !playerId || !isConnected || room.game_phase !== "simultaneous_clues") return false;
    try {
      await GameStore.updatePlayer(roomCode, playerId, { clue, has_submitted_clue: true });
      const updatedRoom = await GameStore.getRoom(roomCode);
      if (!updatedRoom) return false;
      setRoom(updatedRoom); // Update local state with player's submitted clue status

      const activePlayers = updatedRoom.players.filter(p => !p.is_eliminated);
      const allCluesSubmitted = activePlayers.every(p => p.has_submitted_clue);
      if (allCluesSubmitted && activePlayers.length > 0) {
        await GameStore.updateRoom(roomCode, { game_phase: "voting", time_left: 0 } as any);
      }
      return true;
    } catch (err) { console.error("Error submitting clue:", err); setError("Failed to submit clue."); return false; }
  }, [room, playerId, isConnected, roomCode]);

  const submitVote = useCallback( async (votedPlayerId: string) => {
    if (!room || !playerId || !isConnected || room.game_phase !== 'voting') return false;
    try {
      const voter = room.players.find(p => p.id === playerId);
      if (voter?.has_voted) { setError("You have already voted."); return false; }

      const votedPlayer = room.players.find((p) => p.id === votedPlayerId);
      if (!votedPlayer) { setError("Selected player not found."); return false; }

      await GameStore.updatePlayer(roomCode, votedPlayerId, { votes: (votedPlayer.votes || 0) + 1 });
      await GameStore.updatePlayer(roomCode, playerId, { has_voted: true });

      let currentRoom = await GameStore.getRoom(roomCode);
      if (!currentRoom) { setError("Failed to get room state after vote."); return false; }
      setRoom(currentRoom); // Reflect own vote

      const activePlayers = currentRoom.players.filter(p => !p.is_eliminated);
      const allVoted = activePlayers.every(p => p.has_voted);

      if (allVoted) {
        const voteCountsForDisplay: Record<string, number> = {};
        currentRoom.players.forEach(p => { voteCountsForDisplay[p.id] = p.votes || 0; });

        const revealVotesTime = 7;
        await GameStore.updateRoom(roomCode, {
          game_phase: "reveal_votes", voteCounts: voteCountsForDisplay, time_left: revealVotesTime,
          eliminationResult: null, lastEliminatedPlayerId: null, gameWinner: null,
        });

        if (isAdmin) {
          setTimeout(async () => {
            let roomAfterReveal = await GameStore.getRoom(roomCode);
            if (!roomAfterReveal || roomAfterReveal.game_phase !== "reveal_votes") return;

            let playerToEliminate: Player | undefined = undefined;
            let currentEliminationResult: string | null = null;
            let currentLastEliminatedPlayerId: string | null = null;
            const currentVoteCounts = roomAfterReveal.voteCounts || {};
            const candidates = roomAfterReveal.players.filter(p => !p.is_eliminated);
            let maxVotes = -1;
            let playersWithMax: Player[] = [];

            if (candidates.length > 0) {
              candidates.forEach(c => {
                const votes = currentVoteCounts[c.id] || 0;
                if (votes > maxVotes) { maxVotes = votes; playersWithMax = [c]; }
                else if (votes === maxVotes) { playersWithMax.push(c); }
              });
              if (maxVotes > 0 && playersWithMax.length === 1) {
                playerToEliminate = playersWithMax[0];
                await GameStore.updatePlayer(roomCode, playerToEliminate.id, { is_eliminated: true });
                currentEliminationResult = `Player ${playerToEliminate.name} has been eliminated.`;
                currentLastEliminatedPlayerId = playerToEliminate.id;
              } else { currentEliminationResult = "No one was eliminated this round."; }
            } else { currentEliminationResult = "No candidates for elimination."; }

            for (const p of roomAfterReveal.players) {
              await GameStore.updatePlayer(roomCode, p.id, { votes: 0, has_voted: false });
            }

            let roomAfterElimination = await GameStore.getRoom(roomCode);
            if (!roomAfterElimination) { setError("Failed to get room state after elimination."); return; }

            const finalActive = roomAfterElimination.players.filter(p => !p.is_eliminated);
            let gameWinner: 'majority' | 'imposters' | null = null;

            const wordSet = new Set(roomAfterElimination.players.map(p => p.word).filter(Boolean));
            const distinctWords = Array.from(wordSet) as string[];
            let actualMajorityWord = "", actualImposterWord = "";
            if (distinctWords.length === 1) actualMajorityWord = distinctWords[0];
            if (distinctWords.length === 2) {
                const c1 = roomAfterElimination.players.filter(p => p.word === distinctWords[0]).length;
                const c2 = roomAfterElimination.players.filter(p => p.word === distinctWords[1]).length;
                actualMajorityWord = c1 >= c2 ? distinctWords[0] : distinctWords[1];
                actualImposterWord = c1 < c2 ? distinctWords[0] : distinctWords[1];
            }

            const activeMaj = finalActive.filter(p => p.word === actualMajorityWord).length;
            const activeImp = finalActive.filter(p => p.word === actualImposterWord && actualImposterWord).length;

            if (!actualImposterWord || activeImp === 0) gameWinner = 'majority';
            else if (activeMaj === 0) gameWinner = 'imposters';
            else if (activeImp > 0 && activeImp >= activeMaj) gameWinner = 'imposters';

            if (gameWinner) {
              await GameStore.updateRoom(roomCode, {
                eliminationResult: currentEliminationResult, lastEliminatedPlayerId: currentLastEliminatedPlayerId,
                gameWinner, game_phase: "results", time_left: 0, voteCounts: currentVoteCounts,
              });
            } else {
              for (const p of finalActive) {
                await GameStore.updatePlayer(roomCode, p.id, { clue: "", has_submitted_clue: false });
              }
              const roomForNextRound = await GameStore.getRoom(roomCode);
              if(!roomForNextRound) {setError("Failed to get room for next round."); return;}
              await GameStore.updateRoom(roomCode, {
                game_phase: "simultaneous_clues", round: roomForNextRound.round + 1, time_left: 20,
                current_player_index: 0, eliminationResult: null, lastEliminatedPlayerId: null, voteCounts: null,
              });
            }
          }, revealVotesTime * 1000);
        }
      }
      return true;
    } catch (err) {
      console.error("Failed to submit vote:", err);
      setError("Failed to submit vote.");
      return false;
    }
  }, [room, playerId, isConnected, roomCode, isAdmin]);

  const leaveRoom = useCallback(async () => {
    if (!playerId) return;
    try { await GameStore.removePlayer(roomCode, playerId); }
    catch (err) { console.error("Failed to leave room:", err); }
  }, [playerId, roomCode]);

  const restartGame = useCallback(async () => {
    if (!room || !playerId || !isConnected || !isAdmin || room.game_phase !== "results") {
      setError("Only admin can restart from results."); return false;
    }
    try {
      for (const p of room.players) {
        await GameStore.updatePlayer(roomCode, p.id, {
          word: "", clue: "", votes: 0, is_eliminated: false, has_voted: false, has_submitted_clue: false,
        });
      }
      await GameStore.updateRoom(roomCode, {
        game_phase: "lobby", round: 1, current_player_index: 0, time_left: 0,
        eliminationResult: null, gameWinner: null, lastEliminatedPlayerId: null, voteCounts: null,
      } as any);
      return true;
    } catch (err) { console.error("Error restarting game:", err); setError("Failed to restart game."); return false; }
  }, [room, playerId, isConnected, roomCode, isAdmin]);

  const retry = useCallback(() => {
    connectionAttempted.current = false;
    setIsConnecting(true); setError(""); setIsConnected(false);
  }, []);

  return {
    room, playerId, error, isConnected, isConnecting,
    updateSettings, startGame, submitClue, submitVote, leaveRoom, retry, backendType, restartGame,
  };
}

function generateWords(difficulty: string): { majorityWord: string; imposterWord: string } {
  const wordPairs = {
    easy: [ { majorityWord: "Dog", imposterWord: "Wolf" }, { majorityWord: "Cat", imposterWord: "Tiger" }, ],
    medium: [ { majorityWord: "Violin", imposterWord: "Viola" }, { majorityWord: "Crocodile", imposterWord: "Alligator" }, ],
    hard: [ { majorityWord: "Sonnet", imposterWord: "Haiku" }, { majorityWord: "Stalactite", imposterWord: "Stalagmite" }, ],
  };
  const selectedPairs = wordPairs[difficulty as keyof typeof wordPairs] || wordPairs.medium;
  return selectedPairs[Math.floor(Math.random() * selectedPairs.length)];
}
[end of hooks/use-multiplayer.ts]
