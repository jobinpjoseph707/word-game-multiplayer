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
            if (result.playerId) {
              const success = await GameStore.heartbeat(result.playerId)
              if (!success && isMounted) {
                console.warn("Heartbeat failed, connection may be lost")
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
                    console.log("Room change detected:", payload)
                    // Fetch the latest room data when changes occur
                    const updatedRoom = await GameStore.getRoom(roomCode)
                    if (isMounted && updatedRoom) {
                      console.log("Updating room with", updatedRoom.players.length, "players")
                      setRoom(updatedRoom)
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
                    console.log("Player change detected:", payload)
                    // Fetch the latest room data when player changes occur
                    const updatedRoom = await GameStore.getRoom(roomCode)
                    if (isMounted && updatedRoom) {
                      console.log("Updating room with", updatedRoom.players.length, "players")
                      setRoom(updatedRoom)
                    }
                  },
                )
                .subscribe((status) => {
                  console.log("Subscription status:", status)
                  if (status === "SUBSCRIBED") {
                    console.log("Successfully subscribed to real-time updates")
                  } else if (status === "CHANNEL_ERROR") {
                    console.error("Subscription error, falling back to polling")
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

    // Need at least 3 players
    if (room.players.length < 3) {
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
          has_voted: false,
        }
      })

      // Update each player sequentially to ensure all get words
      for (const playerUpdate of playerUpdates) {
        const success = await GameStore.updatePlayer(roomCode, playerUpdate.id, playerUpdate)
        if (!success) {
          console.error(`Failed to update player ${playerUpdate.id}`)
          return false
        }
      }

      // Start game with countdown
      const updatedRoom = await GameStore.updateRoom(roomCode, {
        game_phase: "starting",
        time_left: 10, // 10 second countdown
        current_player_index: 0, // Reset to first player
      } as any)

      if (updatedRoom) {
        setRoom(updatedRoom)
        console.log("Game started successfully, all players should have words")

        // After countdown, move to clue phase
        setTimeout(async () => {
          await GameStore.updateRoom(roomCode, {
            game_phase: "clues",
            time_left: 30, // 30 seconds per player to give clue
          } as any)
        }, 10000)

        return true
      }
      return false
    } catch (err) {
      console.error("Failed to start game:", err)
      return false
    }
  }, [room, isConnected, roomCode])

  // Submit clue
  const submitClue = useCallback(
    async (clue: string) => {
      if (!room || !playerId || !isConnected) return false

      try {
        // Update player's clue
        await GameStore.updatePlayer(roomCode, playerId, { clue })

        // Check if all players have submitted clues
        const updatedRoom = await GameStore.getRoom(roomCode)
        if (!updatedRoom) return false

        const allCluesSubmitted = updatedRoom.players.every((p) => p.clue)

        if (allCluesSubmitted) {
          // Move to discussion phase
          await GameStore.updateRoom(roomCode, {
            game_phase: "discussion",
            time_left: 60, // 60 seconds for discussion
          } as any)

          // After discussion, move to voting phase
          setTimeout(async () => {
            await GameStore.updateRoom(roomCode, {
              game_phase: "voting",
              time_left: 30, // 30 seconds for voting
            } as any)
          }, 60000)
        } else {
          // Move to next player
          const nextPlayerIndex = (updatedRoom.current_player_index + 1) % updatedRoom.players.length
          await GameStore.updateRoom(roomCode, {
            current_player_index: nextPlayerIndex,
          } as any)
        }

        return true
      } catch (err) {
        console.error("Failed to submit clue:", err)
        return false
      }
    },
    [room, playerId, isConnected, roomCode],
  )

  // Submit vote
  const submitVote = useCallback(
    async (votedPlayerId: string) => {
      if (!room || !playerId || !isConnected) return false

      try {
        // Find the player being voted for
        const votedPlayer = room.players.find((p) => p.id === votedPlayerId)
        if (!votedPlayer) return false

        // Increment votes for the player
        await GameStore.updatePlayer(roomCode, votedPlayerId, {
          votes: (votedPlayer.votes || 0) + 1,
        })

        // Mark current player as having voted
        await GameStore.updatePlayer(roomCode, playerId, {
          has_voted: true,
        } as any)

        // Check if all players have voted
        const updatedRoom = await GameStore.getRoom(roomCode)
        if (!updatedRoom) return false

        const allVoted = updatedRoom.players.every((p) => p.has_voted)

        if (allVoted) {
          // Find player with most votes
          const mostVotedPlayer = updatedRoom.players.reduce(
            (prev, current) => (prev.votes > current.votes ? prev : current),
            { votes: -1 } as any,
          )

          // Eliminate player with most votes
          await GameStore.updatePlayer(roomCode, mostVotedPlayer.id, {
            is_eliminated: true,
          })

          // Reset votes for next round
          for (const player of updatedRoom.players) {
            await GameStore.updatePlayer(roomCode, player.id, {
              votes: 0,
              has_voted: false,
            } as any)
          }

          // Check game end conditions
          const eliminatedPlayers = updatedRoom.players.filter((p) => p.is_eliminated)
          const activePlayers = updatedRoom.players.filter((p) => !p.is_eliminated)

          // Get unique words
          const words = [...new Set(updatedRoom.players.map((p) => p.word))]
          const majorityWord = words[0] // Assuming first word is majority
          const imposterWord = words.length > 1 ? words[1] : null

          // Count active players with each word
          const activeMajority = activePlayers.filter((p) => p.word === majorityWord).length
          const activeImposters = imposterWord ? activePlayers.filter((p) => p.word === imposterWord).length : 0

          // Game ends if all imposters eliminated or if imposters >= majority
          const gameOver = activeImposters === 0 || activeImposters >= activeMajority

          if (gameOver) {
            // Move to results phase
            await GameStore.updateRoom(roomCode, {
              game_phase: "results",
            } as any)
          } else {
            // Start next round
            await GameStore.updateRoom(roomCode, {
              round: updatedRoom.round + 1,
              game_phase: "clues",
              current_player_index: 0,
              time_left: 30,
            } as any)
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
