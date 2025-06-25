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
  game_phase: "lobby" | "starting" | "clues" | "discussion" | "voting" | "results" | "round_results" // Potentially add "round_results" if needed
  current_player_index: number
  time_left: number
  round: number
  eliminationResult: string | null
  gameWinner: 'majority' | 'imposters' | null
  lastEliminatedPlayerId: string | null
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
  is_ready_to_vote?: boolean; // New field for discussion phase
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
  const heartbeatFailures = useRef(0) // Keep track of consecutive heartbeat failures
  let isMounted = true

  // Initialize connection
  useEffect(() => {
    // Prevent multiple connection attempts
    if (connectionAttempted.current) {
      console.log("Connection already attempted, skipping...")
      return
    }

    connectionAttempted.current = true

    const connectToRoom = async () => {
      try {
        setBackendType(GameStore.getBackendType())
        setIsConnecting(true)
        setError("")

        console.log(`Attempting to ${isAdmin ? "connect to" : "join"} room: ${roomCode} as ${playerName}`)

        let result
        if (isAdmin) {
          // For admin, check if room already exists (they may have created it already)
          const existingRoom = await GameStore.getRoom(roomCode)

          if (existingRoom) {
            // Room exists, check if this admin can reconnect
            const adminPlayer = existingRoom.players.find(
              (p) => p.is_admin && p.name.toLowerCase() === playerName.toLowerCase(),
            )

            if (adminPlayer) {
              // Admin can reconnect to existing room
              console.log("Reconnecting admin to existing room")
              result = { room: existingRoom, playerId: adminPlayer.id }
            } else {
              // Room exists but admin can't reconnect
              throw new Error("Room code already exists with different admin")
            }
          } else {
            // Room doesn't exist, this shouldn't happen if we created it in the parent
            throw new Error("Room not found after creation")
          }
        } else {
          // Player is joining the room
          result = await GameStore.joinRoom(roomCode, playerName)
        }

        if (!result) {
          throw new Error(isAdmin ? "Failed to connect to room" : "Failed to join room")
        }

        if (isMounted) {
          setRoom(result.room)
          setPlayerId(result.playerId)
          setIsConnected(true)
          console.log(`Successfully ${isAdmin ? "connected to" : "joined"} room:`, result.room.id)

          // Start heartbeat immediately
          heartbeatInterval.current = setInterval(async () => {
            if (result.playerId && isMounted) {
              const success = await GameStore.heartbeat(result.playerId)
              if (!success) {
                heartbeatFailures.current++
                console.warn(`Heartbeat failed (${heartbeatFailures.current} consecutive)`)
                if (heartbeatFailures.current >= 3) {
                  setError("Connection lost (heartbeat). Please try reconnecting.")
                  setIsConnected(false)
                  if (heartbeatInterval.current) clearInterval(heartbeatInterval.current)
                  // Optionally, also clear polling if it's active due to an earlier fallback
                  if (pollingInterval.current) clearInterval(pollingInterval.current)
                }
              } else {
                heartbeatFailures.current = 0 // Reset on successful heartbeat
              }
            }
          }, 30000) // Send heartbeat every 30 seconds

          // Set up real-time subscription if using Supabase
          if (isSupabaseConfigured()) {
            try {
              const supabase = getSupabaseClient()

              // Subscribe to room changes with better error handling
              const newSubscription = supabase
                .channel(`room:${roomCode}`)
                .on(
                  "postgres_changes",
                  {
                    event: "*",
                    schema: "public",
                    table: "game_rooms",
                    filter: `id=eq.${roomCode.toUpperCase()}`,
                  },
                  async (payload) => {
                    console.log(`[Supabase Realtime] Event on 'game_rooms' received for room ${roomCode}. Type: ${payload.eventType}. Payload:`, JSON.stringify(payload));
                    const updatedRoom = await GameStore.getRoom(roomCode);
                    if (isMounted && updatedRoom) {
                      console.log(`[Supabase Realtime] 'game_rooms' event: Updating room ${roomCode} with ${updatedRoom.players.length} players. Player IDs: ${updatedRoom.players.map(p=>p.id).join(', ')}.`);
                      setRoom(updatedRoom);
                      setError(""); // Clear previous sync errors if successful
                    } else if (isMounted && !updatedRoom) {
                      console.warn(`[Supabase Realtime] 'game_rooms' event: GameStore.getRoom(${roomCode}) returned null or undefined.`);
                      setError("Failed to refresh room data after a game update. Player list or game state may be outdated.");
                    } else if (!isMounted) {
                      console.log(`[Supabase Realtime] 'game_rooms' event: Component not mounted, skipping setRoom for room ${roomCode}.`);
                    }
                  },
                )
                .on(
                  "postgres_changes",
                  {
                    event: "*",
                    schema: "public",
                    table: "players",
                    filter: `room_id=eq.${roomCode.toUpperCase()}`,
                  },
                  async (payload) => {
                  console.log(`[Supabase Realtime] Event on 'game_rooms' received for room ${roomCode}. Payload:`, JSON.stringify(payload));
                    // Fetch the latest room data when player changes occur
                  const updatedRoom = await GameStore.getRoom(roomCode);
                    if (isMounted && updatedRoom) {
                    console.log(`[Supabase Realtime] 'game_rooms' event: Updating room ${roomCode} with ${updatedRoom.players.length} players. Full room data:`, JSON.stringify(updatedRoom));
                    setRoom(updatedRoom);
                  } else if (isMounted && !updatedRoom) {
                    console.warn(`[Supabase Realtime] 'game_rooms' event: GameStore.getRoom(${roomCode}) returned null or undefined.`);
                    }
                  },
                )
                .subscribe((status) => {
                  console.log("Subscription status:", status)
                  if (status === "SUBSCRIBED") {
                    console.log("Successfully subscribed to real-time updates")
                    setError(""); // Clear any previous polling warning
                  } else if (status === "CHANNEL_ERROR") {
                    console.error("Subscription error, falling back to polling")
                    setError("Real-time connection issue. Switched to fallback mode (slower updates).")
                    setupPolling()
                  }
                })

              setSubscription(newSubscription)
              console.log("Supabase real-time subscription established")
            } catch (subscriptionError) {
              console.error("Failed to set up real-time subscription:", subscriptionError)
              // Fall back to polling if subscription fails
              setupPolling()
            }
          } else {
            // Use polling for in-memory backend
            setupPolling()
          }
        }
      } catch (err) {
        if (isMounted) {
          console.error("Connection error:", err)
          setError(err instanceof Error ? err.message : "Failed to connect to room")
          setIsConnected(false)
        }
      } finally {
        if (isMounted) {
          setIsConnecting(false)
        }
      }
    }

    connectToRoom()

    return () => {
      isMounted = false
      if (pollingInterval.current) clearInterval(pollingInterval.current)
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current)

      // Clean up Supabase subscription
      if (subscription) {
        const supabase = getSupabaseClient()
        supabase.channel(subscription.topic).unsubscribe()
        console.log("Supabase subscription cleaned up")
      }
    }
  }, [roomCode, playerName, isAdmin])

  const setupPolling = () => {
    // Set up polling for room updates with more frequent updates
    pollingInterval.current = setInterval(async () => {
      try {
        // Get latest room data
        const updatedRoom = await GameStore.getRoom(roomCode)
        if (isMounted) {
          if (updatedRoom) {
            // Only update if there are actual changes
            if (
              !room ||
              room.players.length !== updatedRoom.players.length ||
              JSON.stringify(room.players) !== JSON.stringify(updatedRoom.players)
            ) {
              console.log("Polling: Updating room with", updatedRoom.players.length, "players")
              setRoom(updatedRoom)
            }
          } else if (isConnected) {
            // Room was deleted or doesn't exist anymore
            setError("Room no longer exists")
            setIsConnected(false)
          }
        }
      } catch (err) {
        console.error("Polling error:", err)
      }
    }, 1000) // Poll every 1 second for better responsiveness
  }

  // Update settings
  const updateSettings = useCallback(
    async (settings: Partial<Room["settings"]>) => {
      if (!room || !isConnected) return false

      try {
        const updatedRoom = await GameStore.updateRoom(roomCode, {
          settings: { ...room.settings, ...settings },
        } as any)

        if (updatedRoom) {
          setRoom(updatedRoom)
          return true
        }
        return false
      } catch (err) {
        console.error("Failed to update settings:", err)
        return false
      }
    },
    [room, isConnected, roomCode],
  )

  // Start game
  const startGame = useCallback(async () => {
    if (!room || !isConnected) return false

    // Need at least 2 players (new requirement)
    if (room.players.length < 2) {
      setError("At least 2 players are required to start the game."); // Also set error for more feedback
      return false
    }

    try {
      // Generate words based on difficulty
      const { majorityWord, imposterWord } = generateWords(room.settings.difficulty)
      console.log("Generated words:", { majorityWord, imposterWord })

      // Assign words to players
      const playerCount = room.players.length
      const imposterCount = Math.min(room.settings.imposterCount, Math.floor(playerCount / 2))

      // Create array of player indices
      const indices = Array.from({ length: playerCount }, (_, i) => i)

      // Shuffle indices using Fisher-Yates algorithm
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[indices[i], indices[j]] = [indices[j], indices[i]]
      }

      // Select imposters
      const imposterIndices = indices.slice(0, imposterCount)
      console.log("Imposter indices:", imposterIndices)

      // Update ALL players with words (including admin)
      const playerUpdates = room.players.map((player, index) => {
        const isImposter = imposterIndices.includes(index)
        const assignedWord = isImposter ? imposterWord : majorityWord
        console.log(
          `Player ${player.name} (${player.id}) gets word: ${assignedWord} (${isImposter ? "imposter" : "majority"})`,
        )

        return {
          id: player.id,
          word: assignedWord,
          clue: "",
          votes: 0,
          is_eliminated: false,
          // has_voted: false, // Temporarily remove to prevent crash if column is missing.
                            // Relies on DB default if column exists. Voting will need has_voted.
        }
      })

      // Update each player sequentially to ensure all get words
      for (const playerUpdate of playerUpdates) {
        const playerUpdateResult = await GameStore.updatePlayer(roomCode, playerUpdate.id, playerUpdate)
        if (!playerUpdateResult) {
          console.error(`Failed to update player ${playerUpdate.id} during game start`)
          setError("Error initializing player data for the game. Please try again.")
          return false
        }
      }

      // Phase 1: Word Reveal (5 seconds)
      let currentRoomState = await GameStore.updateRoom(roomCode, {
        game_phase: "starting", // Keep using "starting" for word reveal phase
        time_left: 5,          // 5 second word reveal
        current_player_index: 0, // Reset, though not used for clues now
        round: 1, // Ensure round starts at 1
        eliminationResult: null,
        gameWinner: null,
        lastEliminatedPlayerId: null,
      } as any)

      if (!currentRoomState) {
        setError("Failed to start word reveal phase.");
        return false;
      }
      setRoom(currentRoomState);
      console.log("Game started: Word reveal phase (5s). Players should have words.");

      // Admin client orchestrates phase transitions via timeouts
      if (isAdmin) {
        // After 5s (word reveal ends), transition to simultaneous clue submission
        setTimeout(async () => {
          const roomAtTimeOfRevealEnd = await GameStore.getRoom(roomCode);
          if (roomAtTimeOfRevealEnd && roomAtTimeOfRevealEnd.game_phase === "starting" && isConnected && room) {
            console.log("Word reveal ended. Transitioning to simultaneous clue submission (20s).");
            currentRoomState = await GameStore.updateRoom(roomCode, {
              game_phase: "simultaneous_clues", // New phase
              time_left: 20,                   // 20 seconds for everyone to submit clues
              current_player_index: 0,         // Reset
            } as any);

            if (currentRoomState) {
              setRoom(currentRoomState); // Update admin's room state

              // After 20s (clue submission ends), transition to discussion
              setTimeout(async () => {
                const roomAtTimeOfClueEnd = await GameStore.getRoom(roomCode);
                if (roomAtTimeOfClueEnd && roomAtTimeOfClueEnd.game_phase === "simultaneous_clues" && isConnected && room) {
                  console.log("Simultaneous clue submission ended. Transitioning to discussion (20s)."); // Log updated
                  const discussionRoomState = await GameStore.updateRoom(roomCode, {
                    game_phase: "discussion",
                    time_left: 0, // No specific timer for discussion phase, it ends when players are ready
                                   // Or set a very long default display timer if needed: e.g., 999
                    current_player_index: 0, // Reset
                  } as any);

                  if (!discussionRoomState) {
                    setError("Failed to transition to discussion phase.");
                  }
                  // No automatic timeout to end discussion here anymore.
                  // Transition to voting will be handled by playerReadyToVote logic.
                  // Admin's setRoom will be called via subscription for the discussion phase change.
                }
              }, 20000); // 20 seconds for clue submission
            } else {
              setError("Failed to transition to simultaneous clue phase.");
            }
          }
        }, 5000); // 5 seconds for word reveal
      }
      return true; // startGame initiated successfully from admin's perspective
    } catch (err) {
      console.error("Failed to start game:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred while starting the game.");
      return false; // Ensure startGame returns false on error
    }
  }, [room, playerId, isConnected, roomCode, isAdmin]) // Added isAdmin, playerId might be needed if error involves specific player actions by admin

  // Submit clue
  const submitClue = useCallback(
    async (clue: string) => {
      if (!room || !playerId || !isConnected || room.game_phase !== "simultaneous_clues") {
        // Only allow clue submission during the correct phase
        if (room && room.game_phase !== "simultaneous_clues") {
            console.warn(`SubmitClue called outside of 'simultaneous_clues' phase. Current phase: ${room.game_phase}`);
            setError(`You can only submit clues during the clue submission window.`);
        }
        return false;
      }

      try {
        // 1. Current player submits their clue
        const playerUpdateResult = await GameStore.updatePlayer(roomCode, playerId, { clue });

        if (!playerUpdateResult) {
          setError("Failed to submit your clue. Please try again.");
          return false;
        }

        // After successfully submitting a clue, update the local room state
        // to reflect this player's clue. GameStore.updatePlayer now returns the full room.
        setRoom(playerUpdateResult);
        // No need to fetch room state again explicitly here, as playerUpdateResult is the new room state.

        console.log(`Player ${playerId} submitted clue: "${clue}"`);
        return true; // Indicate success

      } catch (err) {
        console.error("Error in submitClue:", err);
        setError(err instanceof Error ? err.message : "An unknown error occurred while submitting clue.");
        return false;
      }
    },
    [room, playerId, isConnected, roomCode], // roomCode was missing, add room?.game_phase for the check
  )

  // Submit vote
  const submitVote = useCallback(
    async (votedPlayerId: string) => {
      if (!room || !playerId || !isConnected) return false

      try {
        // Find the player being voted for
        const votedPlayer = room.players.find((p) => p.id === votedPlayerId)
        if (!votedPlayer) {
            setError("Selected player not found. Vote not registered."); // Should not happen typically
            return false;
        }

        // Increment votes for the player
        const voteIncrementSuccess = await GameStore.updatePlayer(roomCode, votedPlayerId, {
          votes: (votedPlayer.votes || 0) + 1,
        })
        if (!voteIncrementSuccess) {
            setError("Failed to register your vote. Please try again.");
            return false;
        }

        // Mark current player as having voted
        const markVotedSuccess = await GameStore.updatePlayer(roomCode, playerId, {
          has_voted: true,
        } as any)
        if (!markVotedSuccess) {
            // This is less critical for the voter, but good to log or handle if needed.
            // For now, we'll proceed as the vote itself was registered.
            console.warn("Failed to mark player as voted, but vote was registered.");
        }

        // Fetch latest room state after player's vote is recorded.
        let roomAfterVote = await GameStore.getRoom(roomCode)
        if (!roomAfterVote) {
            setError("Failed to fetch room state after voting.");
            return false;
        }
        setRoom(roomAfterVote) // Update local state

        const activePlayersInRoom = roomAfterVote.players.filter(p => !p.is_eliminated);
        const nonVotedActivePlayers = activePlayersInRoom.filter(p => !p.has_voted).length;

        if (nonVotedActivePlayers === 0) {
          // All active players have voted. Proceed to tally and game logic.
          let playerToEliminate: Player | undefined = undefined;
          let currentEliminationResult: string | null = null;
          let currentLastEliminatedPlayerId: string | null = null;
          let currentRoomState = await GameStore.getRoom(roomCode); // Get fresh state before updates

          if (!currentRoomState) {
            setError("Failed to fetch room state before tallying votes.");
            return false;
          }

          const candidatesForElimination = currentRoomState.players.filter(p => !p.is_eliminated);

          if (candidatesForElimination.length > 0) {
            let maxVotes = -1;
            let playersWithMaxVotes: Player[] = [];
            for (const candidate of candidatesForElimination) {
              const currentVotes = candidate.votes || 0;
              if (currentVotes > maxVotes) {
                maxVotes = currentVotes;
                playersWithMaxVotes = [candidate];
              } else if (currentVotes === maxVotes) {
                playersWithMaxVotes.push(candidate);
              }
            }

            if (maxVotes > 0 && playersWithMaxVotes.length === 1) {
              playerToEliminate = playersWithMaxVotes[0];
              currentEliminationResult = `Player ${playerToEliminate.name} has been eliminated.`;
              currentLastEliminatedPlayerId = playerToEliminate.id;
              // Mark player as eliminated in the database
              await GameStore.updatePlayer(roomCode, playerToEliminate.id, { is_eliminated: true });
            } else {
              currentEliminationResult = "No one was eliminated this round.";
              currentLastEliminatedPlayerId = null;
              if (maxVotes > 0 && playersWithMaxVotes.length > 1) {
                console.log("Tie in votes. No player eliminated.");
              } else {
                console.log("No player received positive votes. No player eliminated.");
              }
            }
          } else {
            currentEliminationResult = "No candidates for elimination."; // Should not happen if game is ongoing
          }

          // Reset votes and has_voted status for ALL players for the next round/end game
          for (const p of currentRoomState.players) {
            await GameStore.updatePlayer(roomCode, p.id, { votes: 0, has_voted: false });
          }

          // Fetch the most up-to-date room state after eliminations and vote resets
          let roomAfterUpdates = await GameStore.getRoom(roomCode);
          if (!roomAfterUpdates) {
            setError("Failed to fetch room state after elimination and vote reset.");
            return false;
          }

          const finalActivePlayers = roomAfterUpdates.players.filter(p => !p.is_eliminated);
          let gameWinner: 'majority' | 'imposters' | null = null;

          // Determine true majority and imposter words based on initial assignments
          // This assumes words don't change mid-game, which is typical.
          // A more robust way would be to store initial role or word type if words can be synonyms.
          // For this, we rely on the distinct words assigned at game start.
          const wordSet = new Set(roomAfterUpdates.players.map(p => p.word).filter(w => w));
          const distinctWords = Array.from(wordSet);
          let actualMajorityWord = distinctWords.length > 0 ? distinctWords[0] : ""; // Fallback
          let actualImposterWord = distinctWords.length > 1 ? distinctWords[1] : ""; // Fallback, might be same if only one word type

          if (distinctWords.length === 2) { // Standard scenario
            const count1 = roomAfterUpdates.players.filter(p => p.word === distinctWords[0]).length;
            const count2 = roomAfterUpdates.players.filter(p => p.word === distinctWords[1]).length;
            actualMajorityWord = count1 >= count2 ? distinctWords[0] : distinctWords[1];
            actualImposterWord = count1 < count2 ? distinctWords[0] : distinctWords[1];
          } else if (distinctWords.length === 1) { // All players got same word (e.g. very small game, no imposters assigned)
            actualMajorityWord = distinctWords[0];
            actualImposterWord = ""; // No imposter word
          }

          const activeMajorityCount = finalActivePlayers.filter(p => p.word === actualMajorityWord).length;
          const activeImposterCount = finalActivePlayers.filter(p => p.word === actualImposterWord && actualImposterWord !== "").length;

          if (actualImposterWord === "" || activeImposterCount === 0) {
            gameWinner = 'majority'; // All imposters eliminated or no imposters to begin with
          } else if (activeMajorityCount === 0) {
            gameWinner = 'imposters'; // All majority players eliminated
          } else if (activeImposterCount >= activeMajorityCount) {
            gameWinner = 'imposters'; // Imposters outnumber or equal majority
          }
          // Add other win conditions if necessary e.g. finalActivePlayers.length <= room.settings.imposterCount

          let nextPhase: Room["game_phase"] = "round_results"; // Default to showing round results
          let nextTimeLeft = 5; // Time for round_results display

          if (gameWinner) {
            nextPhase = "results"; // Go to final game results
            // Update room with game winner and final elimination result
            await GameStore.updateRoom(roomCode, {
              eliminationResult: currentEliminationResult,
              lastEliminatedPlayerId: currentLastEliminatedPlayerId,
              gameWinner: gameWinner,
              game_phase: nextPhase,
              time_left: 0, // Or time for results screen
            });
          } else {
            // Game continues, prepare for next round (clue submission)
            // Reset clues for active players before updating the room for the next phase
            for (const p of finalActivePlayers) {
              await GameStore.updatePlayer(roomCode, p.id, { clue: "" });
            }
            // Update room state for round_results display, then it will transition to simultaneous_clues
            await GameStore.updateRoom(roomCode, {
              eliminationResult: currentEliminationResult,
              lastEliminatedPlayerId: currentLastEliminatedPlayerId,
              gameWinner: null, // Ensure gameWinner is null if game is not over
              game_phase: nextPhase, // "round_results"
              round: roomAfterUpdates.round, // Round will be incremented when moving from round_results
              time_left: nextTimeLeft, // Time for round_results display
            });

            // Admin will orchestrate transition from 'round_results' to 'simultaneous_clues'
            if (isAdmin) {
                setTimeout(async () => {
                    const roomAtRoundResultEnd = await GameStore.getRoom(roomCode);
                    if (roomAtRoundResultEnd && roomAtRoundResultEnd.game_phase === "round_results") {
                        await GameStore.updateRoom(roomCode, {
                            game_phase: "simultaneous_clues",
                            round: roomAtRoundResultEnd.round + 1,
                            time_left: 20, // Time for clue submission
                            current_player_index: 0,
                            eliminationResult: null, // Clear for next round
                            lastEliminatedPlayerId: null, // Clear for next round
                        });
                    }
                }, nextTimeLeft * 1000);
            }
          }
        }
        return true;
      } catch (err) {
        console.error("Failed to submit vote:", err);
        return false
      }
    },
    [room, playerId, isConnected, roomCode],
  )

  // Leave room
  const leaveRoom = useCallback(async () => {
    if (!playerId) return

    try {
      await GameStore.removePlayer(roomCode, playerId)
    } catch (err) {
      console.error("Failed to leave room:", err)
    }
  }, [playerId, roomCode])

  const playerReadyToVote = useCallback(async () => {
    if (!room || !playerId || !isConnected || room.game_phase !== "discussion") {
      console.warn("playerReadyToVote called at inappropriate time.", { phase: room?.game_phase, playerId });
      return false;
    }

    try {
      // 1. Update current player's status
      let updatedRoomState = await GameStore.updatePlayer(roomCode, playerId, { is_ready_to_vote: true });
      if (!updatedRoomState) {
        setError("Failed to set your status to 'Ready to Vote'. Please try again.");
        return false;
      }
      setRoom(updatedRoomState); // Reflect own status change immediately

      // 2. Check if all active, non-eliminated players are ready
      const activePlayers = updatedRoomState.players.filter(p => !p.is_eliminated);
      const allReady = activePlayers.every(p => p.is_ready_to_vote === true);

      if (allReady && activePlayers.length > 0) { // Ensure there are active players
        console.log("All active players are ready to vote. Transitioning to voting phase.");

        // Reset is_ready_to_vote for all players for the next round (if any)
        // This should be done carefully, perhaps as part of phase transition or new round setup.
        // For now, let's do it before transitioning to voting.
        for (const p of updatedRoomState.players) {
          // We only need to reset if they were true. No need to update if already false/undefined.
          if (p.is_ready_to_vote) {
            await GameStore.updatePlayer(roomCode, p.id, { is_ready_to_vote: false });
          }
        }

        // Fetch the state again after resetting is_ready_to_vote, though it might not be strictly necessary
        // if the next updateRoom call for phase transition overwrites it.
        // However, GameStore.updateRoom for phase change will trigger subscriptions for all.

        const finalRoomStateBeforeVote = await GameStore.updateRoom(roomCode, {
          game_phase: "voting",
          time_left: 10, // 10 seconds for voting phase timer display
          current_player_index: 0, // Reset for voting phase if needed by UI, or first active voter
        } as any);

        if (!finalRoomStateBeforeVote) {
          setError("Failed to transition to voting phase.");
          return false;
        }
        // setRoom will be called by subscription for all clients.
      }
      return true;
    } catch (err) {
      console.error("Error in playerReadyToVote:", err);
      setError(err instanceof Error ? err.message : "An error occurred while setting ready status.");
      return false;
    }
  }, [room, playerId, isConnected, roomCode, isAdmin]);


  const restartGame = useCallback(async () => {
    if (!room || !playerId || !isConnected || !isAdmin || room.game_phase !== "results") {
      console.warn("restartGame called at inappropriate time or by non-admin.", {
        phase: room?.game_phase,
        isAdmin,
        playerId
      });
      setError("Only the admin can restart the game from the results screen.");
      return false;
    }

    try {
      console.log(`Admin ${playerId} is restarting the game in room ${roomCode}.`);

      // 1. Reset individual player states
      for (const p of room.players) {
        const playerResetSuccess = await GameStore.updatePlayer(roomCode, p.id, {
          word: "",
          clue: "",
          votes: 0,
          is_eliminated: false,
          has_voted: false,      // Assuming has_voted column exists
          is_ready_to_vote: false, // Reset ready status
          // score: 0, // Optionally reset score, or keep it cumulative
        });
        if (!playerResetSuccess) {
          // Log error but try to continue resetting other players and room
          console.error(`Failed to reset player ${p.id} for new game.`);
          // Potentially collect errors and report a more general one if many fail
        }
      }

      // 2. Reset room state to lobby
      // Important: Fetch the room state *after* player updates if those updates return the room state,
      // or ensure this updateRoom call is the definitive one that clients will sync to for the lobby.
      // Since updatePlayer returns the room state, the final call to updateRoom is primary.
      const lobbyRoomState = await GameStore.updateRoom(roomCode, {
        game_phase: "lobby",
        round: 1,
        current_player_index: 0,
        time_left: 0,
        eliminationResult: null,
        gameWinner: null,
        lastEliminatedPlayerId: null,
        // Settings (totalPlayers, imposterCount, difficulty) are preserved
      } as any);

      if (!lobbyRoomState) {
        setError("Failed to restart the game and return to lobby. Please try again.");
        return false;
      }

      // The admin's client will update its room state via subscription like other clients.
      // No explicit setRoom(lobbyRoomState) needed here for the admin,
      // as the GameStore.updateRoom should trigger subscriptions for all.
      console.log(`Game room ${roomCode} reset to lobby.`);
      return true;

    } catch (err) {
      console.error("Error in restartGame:", err);
      setError(err instanceof Error ? err.message : "An error occurred while restarting the game.");
      return false;
    }
  }, [room, playerId, isConnected, roomCode, isAdmin]);

  // Retry connection
  const retry = useCallback(() => {
    connectionAttempted.current = false
    setIsConnecting(true)
    setError("")
    setIsConnected(false)
    // The useEffect will handle reconnection
  }, [])

  return {
    room,
    playerId,
    error,
    isConnected,
    isConnecting,
    updateSettings,
    startGame,
    submitClue,
    submitVote,
    leaveRoom,
    retry,
    backendType,
    playerReadyToVote,
    restartGame, // New function for Play Again
  }
}

// Helper function to generate word pairs based on difficulty
function generateWords(difficulty: string): { majorityWord: string; imposterWord: string } {
  const wordPairs = {
    easy: [
      { majorityWord: "Dog", imposterWord: "Wolf" },
      { majorityWord: "Cat", imposterWord: "Tiger" },
      { majorityWord: "Car", imposterWord: "Truck" },
      { majorityWord: "Apple", imposterWord: "Pear" },
      { majorityWord: "Chair", imposterWord: "Stool" },
    ],
    medium: [
      { majorityWord: "Violin", imposterWord: "Viola" },
      { majorityWord: "Crocodile", imposterWord: "Alligator" },
      { majorityWord: "Tornado", imposterWord: "Hurricane" },
      { majorityWord: "Cappuccino", imposterWord: "Latte" },
      { majorityWord: "Apartment", imposterWord: "Condominium" },
    ],
    hard: [
      { majorityWord: "Sonnet", imposterWord: "Haiku" },
      { majorityWord: "Stalactite", imposterWord: "Stalagmite" },
      { majorityWord: "Typhoon", imposterWord: "Cyclone" },
      { majorityWord: "Macaroon", imposterWord: "Macaron" },
      { majorityWord: "Kayak", imposterWord: "Canoe" },
    ],
  }

  const selectedPairs = wordPairs[difficulty as keyof typeof wordPairs] || wordPairs.medium
  const randomPair = selectedPairs[Math.floor(Math.random() * selectedPairs.length)]

  return randomPair
}
