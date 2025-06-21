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
  game_phase: "lobby" | "starting" | "clues" | "discussion" | "voting" | "results"
  current_player_index: number
  time_left: number
  round: number
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
                  console.log("Simultaneous clue submission ended. Transitioning to discussion (60s).");
                  const discussionRoomState = await GameStore.updateRoom(roomCode, {
                    game_phase: "discussion",
                    time_left: 60,           // 60 seconds for discussion
                    current_player_index: 0, // Reset
                  } as any);

                  if (discussionRoomState) {
                    // Admin client sets the timeout for discussion to end
                    setTimeout(async () => {
                      const roomAtDiscussionEnd = await GameStore.getRoom(roomCode);
                      if (roomAtDiscussionEnd && roomAtDiscussionEnd.game_phase === "discussion" && isConnected && room) {
                        console.log("Discussion ended. Transitioning to voting (30s).");
                        await GameStore.updateRoom(roomCode, {
                          game_phase: "voting",
                          time_left: 30,
                          current_player_index: 0,
                        } as any);
                      }
                    }, 60000); // 60 seconds for discussion
                  } else {
                    setError("Failed to transition to discussion phase.");
                  }
                  // setRoom for admin will be called via subscription eventually
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
          // All active players have voted. Proceed to tally.
          let playerToEliminate: Player | undefined = undefined;
          let maxVotes = -1;

          // Determine who to eliminate among active players
          // Consider only players who are not already eliminated
          const candidatesForElimination = roomAfterVote.players.filter(p => !p.is_eliminated);

          if (candidatesForElimination.length > 0) {
            // Simple model: player with most votes is eliminated. Ties mean no one or first one.
            // A more robust model might handle ties explicitly (e.g. revote, or random).
            // Current logic: find one player with max votes.
            playerToEliminate = candidatesForElimination.reduce((highestVoted, currentPlayer) => {
                if ((currentPlayer.votes || 0) > (highestVoted.votes || 0)) {
                    return currentPlayer;
                }
                // Basic tie-breaking: keep the one found first if votes are equal.
                // Or, if you want to ensure some elimination, if votes are equal and positive,
                // you might prefer the one earlier in the list or a random one.
                // For simplicity, this picks one. If all have 0 votes, first player is picked.
                return (currentPlayer.votes || 0) === (highestVoted.votes || 0) && (currentPlayer.votes || 0) === 0 ? highestVoted :
                       (currentPlayer.votes || 0) > (highestVoted.votes || 0) ? currentPlayer : highestVoted;

            }, candidatesForElimination[0]); // Initialize with the first candidate

            // Ensure someone was actually voted for (at least 1 vote)
            if (playerToEliminate && (playerToEliminate.votes || 0) > 0) {
                const eliminationSuccess = await GameStore.updatePlayer(roomCode, playerToEliminate.id, { is_eliminated: true });
                if (!eliminationSuccess) {
                    setError("Failed to process elimination. Please try again or contact support.");
                    return false;
                }
            } else {
                console.log("No player received enough votes to be eliminated or tie with zero votes.");
                // In a real game, might announce "No one was eliminated" and proceed to next round/game end check.
                // For now, we proceed as if no one was eliminated this round if no positive votes.
            }
          }


          // Reset votes and has_voted status for ALL players for the next round
          for (const p of roomAfterVote.players) { // Use roomAfterVote.players
            const resetSuccess = await GameStore.updatePlayer(roomCode, p.id, { votes: 0, has_voted: false });
            if (!resetSuccess) {
                // Log this, but don't necessarily stop the game flow if some resets fail.
                console.warn(`Failed to reset votes/voted status for player ${p.id}`);
            }
          }

          // --- Game End Condition Check ---
          const roomAfterEliminationAndReset = await GameStore.getRoom(roomCode);
          if (!roomAfterEliminationAndReset) {
            setError("Failed to fetch room state after vote reset.");
            return false;
          }
          setRoom(roomAfterEliminationAndReset);

          const finalActivePlayers = roomAfterEliminationAndReset.players.filter(p => !p.is_eliminated);

          let trueMajorityWord = "";
          let trueImposterWord = "";
          const wordCounts: { [key: string]: number } = {};
          roomAfterEliminationAndReset.players.forEach(p => {
            if (p.word) wordCounts[p.word] = (wordCounts[p.word] || 0) + 1;
          });
          const sortedWordsByOccurrence = Object.keys(wordCounts).sort((a, b) => wordCounts[b] - wordCounts[a]);

          if (sortedWordsByOccurrence.length > 0) trueMajorityWord = sortedWordsByOccurrence[0];
          if (sortedWordsByOccurrence.length > 1) trueImposterWord = sortedWordsByOccurrence[1];
          else trueImposterWord = trueMajorityWord; // Only one type of word in game

          const activeMajorityCount = finalActivePlayers.filter(p => p.word === trueMajorityWord).length;
          const activeImposterCount = finalActivePlayers.filter(p => p.word === trueImposterWord).length;

          // Game ends if all imposters are eliminated OR if imposters' count is >= majority's count (and majority isn't 0)
          // OR if only one player (or type of player) remains.
          let gameOver = false;
          if (activeImposterCount === 0 && trueImposterWord !== "") { // All imposters gone
            gameOver = true;
          } else if (activeMajorityCount === 0 && trueMajorityWord !== "") { // All majority gone (imposters win)
             gameOver = true;
          } else if (finalActivePlayers.length <= roomAfterEliminationAndReset.settings.imposterCount && trueImposterWord !== "" && activeImposterCount > 0 ) {
            // Imposters win if remaining players are less than or equal to initial imposter count (implies imposters have majority or equal)
            // Ensure imposters are actually present.
            gameOver = true;
          } else if (activeImposterCount > 0 && activeMajorityCount <= activeImposterCount) { // Imposters win if they outnumber or equal majority
            gameOver = true;
          }


          if (gameOver) {
            const resultsUpdateSuccess = await GameStore.updateRoom(roomCode, { game_phase: "results" });
            if (!resultsUpdateSuccess) {
                setError("Failed to transition to results phase.");
                // Game might be stuck, but returning true as vote processing part is done.
                // Or return false to indicate overall failure. Let's make it return false.
                return false;
            }
          } else {
            // Start next round: reset clues for active players
            for (const p of finalActivePlayers) { // Iterate over active players
              const clueResetSuccess = await GameStore.updatePlayer(roomCode, p.id, { clue: "" });
              if (!clueResetSuccess) {
                  console.warn(`Failed to reset clue for player ${p.id} for next round.`);
                  // Not critical enough to stop the game usually.
              }
            }

            // Find first active player for the new round
            let firstPlayerForNextRoundIndex = 0;
            const firstActiveP = roomAfterEliminationAndReset.players.find(p => !p.is_eliminated);
            if (firstActiveP) {
                firstPlayerForNextRoundIndex = roomAfterEliminationAndReset.players.indexOf(firstActiveP);
            }


            // For next round, go back to "starting" (word reveal) phase.
            // The startGame logic's setTimeout chain will handle subsequent transitions
            // but it's only set up if isAdmin. This needs consideration.
            // For simplicity now, let's assume the admin's client is still primary for timed transitions.
            // If a new round starts, it should reset clues and words for players as if starting.
            // The current startGame assigns words. A "nextRound" function might be better.
            // However, to align with the new flow from startGame:
            const nextRoundUpdateSuccess = await GameStore.updateRoom(roomCode, {
              round: roomAfterEliminationAndReset.round + 1,
              game_phase: "starting", // Word reveal for the new round
              current_player_index: 0, // Reset for the start of phases
              time_left: 5,            // 5s for word reveal
            });
            if (!nextRoundUpdateSuccess) {
                setError("Failed to start the next round's word reveal.");
                return false;
            }
          }
        }
        return true
      } catch (err) {
        console.error("Failed to submit vote:", err)
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
