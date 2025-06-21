// Enhanced multiplayer store with better error handling and persistence
import { isSupabaseConfigured, getSupabaseClient } from "./supabase"

interface GameSettings {
  totalPlayers: number
  imposterCount: number
  difficulty: "easy" | "medium" | "hard"
  roundTime: number
}

type GamePhase = "lobby" | "starting" | "clues" | "discussion" | "voting" | "results"

interface GameRoomWithPlayers {
  id: string
  players: any[]
  settings: GameSettings
  game_phase: GamePhase
  current_player_index: number
  time_left: number
  round: number
  created_at: string
  last_activity: string
}

interface Player {
  id: string
  room_id: string
  name: string
  is_admin: boolean
  word?: string
  clue?: string
  votes: number
  is_eliminated: boolean
  score: number
  last_seen: string
  created_at: string
}

// In-memory fallback storage
const gameRooms = new Map<string, GameRoomWithPlayers>()
const playerSessions = new Map<string, { roomId: string; playerId: string; lastSeen: string }>()

// Cleanup inactive rooms and players for in-memory store
const ROOM_TIMEOUT = 2 * 60 * 60 * 1000 // 2 hours
const PLAYER_TIMEOUT = 2 * 60 * 1000 // 2 minutes (reduced from 5 minutes)

// Only start cleanup if we're using in-memory storage
let cleanupInterval: NodeJS.Timeout | null = null

function startCleanupIfNeeded() {
  if (typeof window !== "undefined" && !isSupabaseConfigured() && !cleanupInterval) {
    cleanupInterval = setInterval(() => {
      const now = new Date().toISOString()

      // Clean up old rooms
      for (const [roomId, room] of gameRooms.entries()) {
        if (new Date(now).getTime() - new Date(room.last_activity).getTime() > ROOM_TIMEOUT) {
          gameRooms.delete(roomId)
          // Clean up associated player sessions
          for (const [playerId, session] of playerSessions.entries()) {
            if (session.roomId === roomId) {
              playerSessions.delete(playerId)
            }
          }
        }
      }

      // Clean up inactive players
      for (const [playerId, session] of playerSessions.entries()) {
        if (new Date(now).getTime() - new Date(session.lastSeen).getTime() > PLAYER_TIMEOUT) {
          playerSessions.delete(playerId)
          // Remove player from room
          const room = gameRooms.get(session.roomId)
          if (room) {
            room.players = room.players.filter((p) => p.id !== playerId)
            if (room.players.length === 0) {
              gameRooms.delete(session.roomId)
            } else if (!room.players.some((p) => p.is_admin)) {
              // Make first player admin if no admin left
              room.players[0].is_admin = true
            }
            room.last_activity = now
          }
        }
      }
    }, 30000) // Check every 30 seconds
  }
}

export class GameStore {
  static async createRoom(
    roomCode: string,
    playerName: string,
  ): Promise<{ room: GameRoomWithPlayers; playerId: string }> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.createRoomSupabase(roomCode, playerName)
      } else {
        startCleanupIfNeeded()
        return GameStore.createRoomMemory(roomCode, playerName)
      }
    } catch (error) {
      console.error("Error in createRoom:", error)
      throw error
    }
  }

  static async joinRoom(
    roomCode: string,
    playerName: string,
  ): Promise<{ room: GameRoomWithPlayers; playerId: string } | null> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.joinRoomSupabase(roomCode, playerName)
      } else {
        startCleanupIfNeeded()
        return GameStore.joinRoomMemory(roomCode, playerName)
      }
    } catch (error) {
      console.error("Error in joinRoom:", error)
      return null
    }
  }

  static async getRoom(roomCode: string): Promise<GameRoomWithPlayers | null> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.getRoomSupabase(roomCode)
      } else {
        return GameStore.getRoomMemory(roomCode)
      }
    } catch (error) {
      console.error("Error in getRoom:", error)
      return null
    }
  }

  static async updateRoom(
    roomCode: string,
    updates: Partial<GameRoomWithPlayers>,
  ): Promise<GameRoomWithPlayers | null> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.updateRoomSupabase(roomCode, updates)
      } else {
        return GameStore.updateRoomMemory(roomCode, updates)
      }
    } catch (error) {
      console.error("Error in updateRoom:", error)
      return null
    }
  }

  static async updatePlayer(
    roomCode: string,
    playerId: string,
    updates: Partial<Player>,
  ): Promise<GameRoomWithPlayers | null> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.updatePlayerSupabase(roomCode, playerId, updates)
      } else {
        return GameStore.updatePlayerMemory(roomCode, playerId, updates)
      }
    } catch (error) {
      console.error("Error in updatePlayer:", error)
      return null
    }
  }

  static async removePlayer(roomCode: string, playerId: string): Promise<GameRoomWithPlayers | null> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.removePlayerSupabase(roomCode, playerId)
      } else {
        return GameStore.removePlayerMemory(roomCode, playerId)
      }
    } catch (error) {
      console.error("Error in removePlayer:", error)
      return null
    }
  }

  static async heartbeat(playerId: string): Promise<boolean> {
    try {
      if (isSupabaseConfigured()) {
        return await GameStore.heartbeatSupabase(playerId)
      } else {
        return GameStore.heartbeatMemory(playerId)
      }
    } catch (error) {
      console.error("Error in heartbeat:", error)
      return false
    }
  }

  // Supabase implementations
  static async createRoomSupabase(
    roomCode: string,
    playerName: string,
  ): Promise<{ room: GameRoomWithPlayers; playerId: string }> {
    try {
      const supabase = getSupabaseClient()
      const upperRoomCode = roomCode.toUpperCase()

      // Check if room already exists
      const { data: existingRoom, error: checkError } = await supabase
        .from("game_rooms")
        .select(`
        *,
        players (*)
      `)
        .eq("id", upperRoomCode)
        .single()

      if (checkError && checkError.code !== "PGRST116") {
        // PGRST116 is "no rows returned" which is what we want
        console.error("Room check error:", checkError)
        throw new Error(`Database error: ${checkError.message}`)
      }

      if (existingRoom) {
        // Room exists, check if this user can reconnect as admin
        const adminPlayer = existingRoom.players.find(
          (p: any) => p.is_admin && p.name.toLowerCase() === playerName.toLowerCase(),
        )

        if (adminPlayer) {
          // Update the admin's last seen time
          await supabase.from("players").update({ last_seen: new Date().toISOString() }).eq("id", adminPlayer.id)

          console.log(`Admin reconnected to existing room: ${upperRoomCode}`)
          return {
            room: existingRoom,
            playerId: adminPlayer.id,
          }
        } else {
          throw new Error("Room code already exists with different admin")
        }
      }

      // Room doesn't exist, create it
      const playerId = this.generatePlayerId()
      const now = new Date().toISOString()

      // Create room
      const { data: room, error: roomError } = await supabase
        .from("game_rooms")
        .insert({
          id: upperRoomCode,
          settings: {
            totalPlayers: 6,
            imposterCount: 2,
            difficulty: "easy",
            roundTime: 10,
          },
          game_phase: "lobby",
          current_player_index: 0,
          time_left: 0,
          round: 1,
          last_activity: now,
        })
        .select()
        .single()

      if (roomError) {
        console.error("Room creation error:", roomError)

        // If room was created by another process in the meantime, try to reconnect
        if (roomError.code === "23505") {
          // Unique constraint violation
          console.log("Room was created by another process, attempting to reconnect...")
          const { data: newExistingRoom } = await supabase
            .from("game_rooms")
            .select(`
            *,
            players (*)
          `)
            .eq("id", upperRoomCode)
            .single()

          if (newExistingRoom) {
            const adminPlayer = newExistingRoom.players.find(
              (p: any) => p.is_admin && p.name.toLowerCase() === playerName.toLowerCase(),
            )

            if (adminPlayer) {
              return {
                room: newExistingRoom,
                playerId: adminPlayer.id,
              }
            }
          }
        }

        throw new Error(`Failed to create room: ${roomError.message}`)
      }

      // Create admin player
      const { data: player, error: playerError } = await supabase
        .from("players")
        .insert({
          id: playerId,
          room_id: upperRoomCode,
          name: playerName.trim(),
          is_admin: true,
          word: "",
          clue: "",
          votes: 0,
          is_eliminated: false,
          score: 0,
          last_seen: now,
        })
        .select()
        .single()

      if (playerError) {
        console.error("Player creation error:", playerError)
        // Clean up room if player creation failed
        await supabase.from("game_rooms").delete().eq("id", upperRoomCode)
        throw new Error(`Failed to create player: ${playerError.message}`)
      }

      console.log(`Room created: ${upperRoomCode} by ${playerName} (${playerId})`)

      return {
        room: { ...room, players: [player] },
        playerId,
      }
    } catch (error) {
      console.error("Create room error:", error)
      throw error
    }
  }

  static async joinRoomSupabase(
    roomCode: string,
    playerName: string,
  ): Promise<{ room: GameRoomWithPlayers; playerId: string } | null> {
    try {
      const supabase = getSupabaseClient()
      const upperRoomCode = roomCode.toUpperCase()

      // Get room with players
      const { data: room, error: roomError } = await supabase
        .from("game_rooms")
        .select(`
        *,
        players (*)
      `)
        .eq("id", upperRoomCode)
        .single()

      if (roomError) {
        console.error("Room fetch error:", roomError)
        throw new Error(`Room not found: ${upperRoomCode}`)
      }

      if (!room) {
        console.log(`Room not found: ${upperRoomCode}`)
        return null
      }

      if (room.game_phase !== "lobby") {
        console.log(`Room ${upperRoomCode} is not in lobby phase: ${room.game_phase}`)
        throw new Error(`Room ${upperRoomCode} is already in progress`)
      }

      const trimmedName = playerName.trim()

      // Check if player with same name exists and if they're inactive
      const existingPlayer = room.players.find((p: any) => p.name.toLowerCase() === trimmedName.toLowerCase())

      if (existingPlayer) {
        // Check if player has been inactive for more than 2 minutes
        const lastSeen = new Date(existingPlayer.last_seen)
        const now = new Date()
        const timeDiff = now.getTime() - lastSeen.getTime()
        const isInactive = timeDiff > 2 * 60 * 1000 // 2 minutes

        if (isInactive) {
          // Remove the inactive player and let them rejoin fresh
          console.log(`Removing inactive player: ${trimmedName}`)
          await supabase.from("players").delete().eq("id", existingPlayer.id)

          // Update room data after removal
          const { data: updatedRoom } = await supabase
            .from("game_rooms")
            .select(`
              *,
              players (*)
            `)
            .eq("id", upperRoomCode)
            .single()

          if (updatedRoom) {
            room.players = updatedRoom.players
          }
        } else {
          // Player is still active, allow reconnection
          console.log(`Player reconnecting: ${trimmedName}`)
          const currentTime = new Date().toISOString()

          await supabase.from("players").update({ last_seen: currentTime }).eq("id", existingPlayer.id)
          await supabase.from("game_rooms").update({ last_activity: currentTime }).eq("id", upperRoomCode)

          // Fetch the latest room state to ensure fresh data is returned
          const { data: refreshedRoom, error: refreshError } = await supabase
            .from("game_rooms")
            .select(`*, players (*)`)
            .eq("id", upperRoomCode)
            .single()

          if (refreshError) {
            console.error("Error refreshing room data on reconnect:", refreshError)
            // Fallback to the room data fetched earlier, though it might be slightly stale
            return { room: room, playerId: existingPlayer.id }
          }

          return {
            room: refreshedRoom || room, // Prefer refreshedRoom, fallback if somehow null
            playerId: existingPlayer.id,
          }
        }
      }

      // Check if room is full
      if (room.players.length >= room.settings.totalPlayers) {
        console.log(`Room ${upperRoomCode} is full`)
        throw new Error(`Room ${upperRoomCode} is full (${room.players.length}/${room.settings.totalPlayers})`)
      }

      const playerId = this.generatePlayerId()
      const now = new Date().toISOString()

      // Add player to room
      const { data: newPlayer, error: playerError } = await supabase
        .from("players")
        .insert({
          id: playerId,
          room_id: upperRoomCode,
          name: trimmedName,
          is_admin: false,
          word: "",
          clue: "",
          votes: 0,
          is_eliminated: false,
          score: 0,
          last_seen: now,
        })
        .select()
        .single()

      if (playerError) {
        console.error("Join room error:", playerError)
        throw new Error(`Failed to join room: ${playerError.message}`)
      }

      // After the player is successfully added, add this code:
      console.log(`Player joined: ${trimmedName} (${playerId}) to room ${upperRoomCode}`)

      // Update room activity and trigger real-time update
      await supabase
        .from("game_rooms")
        .update({
          last_activity: now,
          // Add a small increment to force real-time update
          current_player_index: room.current_player_index,
        })
        .eq("id", upperRoomCode)

      // Return the updated room with all current players
      const { data: finalRoom } = await supabase
        .from("game_rooms")
        .select(`
          *,
          players (*)
        `)
        .eq("id", upperRoomCode)
        .single()

      return {
        room: finalRoom || {
          ...room,
          players: [...room.players.filter((p: any) => p.id !== existingPlayer?.id), newPlayer],
        },
        playerId,
      }
    } catch (error) {
      console.error("Join room error:", error)
      throw error
    }
  }

  static async getRoomSupabase(roomCode: string): Promise<GameRoomWithPlayers | null> {
    try {
      const supabase = getSupabaseClient()

      const { data: room, error } = await supabase
        .from("game_rooms")
        .select(`
          *,
          players (*)
        `)
        .eq("id", roomCode.toUpperCase())
        .single()

      if (error) {
        if (error.code === "PGRST116") {
          // No rows returned
          return null
        }
        console.error("Get room error:", error)
        throw new Error(`Failed to get room: ${error.message}`)
      }

      if (!room) {
        return null
      }

      return room
    } catch (error) {
      console.error("Get room error:", error)
      throw error
    }
  }

  static async updateRoomSupabase(
    roomCode: string,
    updates: Partial<GameRoomWithPlayers>,
  ): Promise<GameRoomWithPlayers | null> {
    try {
      const supabase = getSupabaseClient()

      // Remove players from updates as they're in a separate table
      const { players, ...roomUpdates } = updates as any

      const { data: room, error } = await supabase
        .from("game_rooms")
        .update({
          ...roomUpdates,
          last_activity: new Date().toISOString(),
        })
        .eq("id", roomCode.toUpperCase())
        .select(`
          *,
          players (*)
        `)
        .single()

      if (error) {
        console.error("Update room error:", error)
        throw new Error(`Failed to update room: ${error.message}`)
      }

      return room
    } catch (error) {
      console.error("Update room error:", error)
      throw error
    }
  }

  static async updatePlayerSupabase(
    roomCode: string,
    playerId: string,
    updates: Partial<Player>,
  ): Promise<GameRoomWithPlayers | null> {
    try {
      const supabase = getSupabaseClient()
      const now = new Date().toISOString()

      console.log(`Updating player ${playerId} with:`, updates)

      // Update player
      const { data: updatedPlayer, error: playerError } = await supabase
        .from("players")
        .update({
          ...updates,
          last_seen: now,
        })
        .eq("id", playerId)
        .eq("room_id", roomCode.toUpperCase())
        .select()
        .single()

      if (playerError) {
        console.error("Update player error:", playerError)
        throw new Error(`Failed to update player: ${playerError.message}`)
      }

      console.log("Player updated successfully:", updatedPlayer)

      // Update room activity to trigger real-time updates
      await supabase
        .from("game_rooms")
        .update({
          last_activity: now,
        })
        .eq("id", roomCode.toUpperCase())

      // Return updated room
      return await this.getRoomSupabase(roomCode)
    } catch (error) {
      console.error("Update player error:", error)
      throw error
    }
  }

  static async removePlayerSupabase(roomCode: string, playerId: string): Promise<GameRoomWithPlayers | null> {
    try {
      const supabase = getSupabaseClient()

      // Remove player
      const { error: playerError } = await supabase
        .from("players")
        .delete()
        .eq("id", playerId)
        .eq("room_id", roomCode.toUpperCase())

      if (playerError) {
        console.error("Remove player error:", playerError)
        throw new Error(`Failed to remove player: ${playerError.message}`)
      }

      // Get remaining players
      const { data: remainingPlayers } = await supabase
        .from("players")
        .select("*")
        .eq("room_id", roomCode.toUpperCase())

      // If no players left, delete room
      if (!remainingPlayers || remainingPlayers.length === 0) {
        await supabase.from("game_rooms").delete().eq("id", roomCode.toUpperCase())

        console.log(`Room deleted: ${roomCode} (no players left)`)
        return null
      }

      // If admin left, make someone else admin
      if (!remainingPlayers.some((p: any) => p.is_admin)) {
        await supabase.from("players").update({ is_admin: true }).eq("id", remainingPlayers[0].id)

        console.log(`New admin: ${remainingPlayers[0].name} in room ${roomCode}`)
      }

      // Update room activity
      await supabase
        .from("game_rooms")
        .update({ last_activity: new Date().toISOString() })
        .eq("id", roomCode.toUpperCase())

      return await this.getRoomSupabase(roomCode)
    } catch (error) {
      console.error("Remove player error:", error)
      throw error
    }
  }

  static async heartbeatSupabase(playerId: string): Promise<boolean> {
    try {
      const supabase = getSupabaseClient()
      const now = new Date().toISOString()

      const { error } = await supabase.from("players").update({ last_seen: now }).eq("id", playerId)

      if (error) {
        console.error("Heartbeat error:", error)
        return false
      }

      return true
    } catch (error) {
      console.error("Heartbeat error:", error)
      return false
    }
  }

  // In-memory implementations (fallback)
  static createRoomMemory(roomCode: string, playerName: string): { room: GameRoomWithPlayers; playerId: string } {
    // Check if room already exists
    if (gameRooms.has(roomCode.toUpperCase())) {
      throw new Error("Room code already exists")
    }

    const playerId = this.generatePlayerId()
    const now = new Date().toISOString()

    const room: GameRoomWithPlayers = {
      id: roomCode.toUpperCase(),
      players: [
        {
          id: playerId,
          room_id: roomCode.toUpperCase(),
          name: playerName.trim(),
          is_admin: true,
          word: "",
          clue: "",
          votes: 0,
          is_eliminated: false,
          score: 0,
          last_seen: now,
          created_at: now,
        },
      ],
      settings: {
        totalPlayers: 6,
        imposterCount: 2,
        difficulty: "easy",
        roundTime: 10,
      },
      game_phase: "lobby",
      current_player_index: 0,
      time_left: 0,
      round: 1,
      created_at: now,
      last_activity: now,
    }

    gameRooms.set(roomCode.toUpperCase(), room)
    playerSessions.set(playerId, { roomId: roomCode.toUpperCase(), playerId, lastSeen: now })

    console.log(`Room created (memory): ${roomCode.toUpperCase()} by ${playerName} (${playerId})`)
    return { room, playerId }
  }

  static joinRoomMemory(roomCode: string, playerName: string): { room: GameRoomWithPlayers; playerId: string } | null {
    const upperRoomCode = roomCode.toUpperCase()
    const room = gameRooms.get(upperRoomCode)

    if (!room) {
      console.log(`Room not found (memory): ${upperRoomCode}`)
      throw new Error(`Room ${upperRoomCode} not found`)
    }

    if (room.game_phase !== "lobby") {
      console.log(`Room ${upperRoomCode} is not in lobby phase: ${room.game_phase}`)
      throw new Error(`Room ${upperRoomCode} is already in progress`)
    }

    const trimmedName = playerName.trim()

    // Check if player with same name exists and if they're inactive
    const existingPlayerIndex = room.players.findIndex((p) => p.name.toLowerCase() === trimmedName.toLowerCase())

    if (existingPlayerIndex !== -1) {
      const existingPlayer = room.players[existingPlayerIndex]
      const lastSeen = new Date(existingPlayer.last_seen)
      const now = new Date()
      const timeDiff = now.getTime() - lastSeen.getTime()
      const isInactive = timeDiff > 2 * 60 * 1000 // 2 minutes

      if (isInactive) {
        // Remove the inactive player
        console.log(`Removing inactive player (memory): ${trimmedName}`)
        room.players.splice(existingPlayerIndex, 1)
        playerSessions.delete(existingPlayer.id)
      } else {
        // Player is still active, allow reconnection
        console.log(`Player reconnecting (memory): ${trimmedName}`)
        const now = new Date().toISOString()
        existingPlayer.last_seen = now
        room.last_activity = now

        const session = playerSessions.get(existingPlayer.id)
        if (session) {
          session.lastSeen = now
        }

        return { room, playerId: existingPlayer.id }
      }
    }

    // Check if room is full
    if (room.players.length >= room.settings.totalPlayers) {
      console.log(`Room ${upperRoomCode} is full`)
      throw new Error(`Room ${upperRoomCode} is full (${room.players.length}/${room.settings.totalPlayers})`)
    }

    const playerId = this.generatePlayerId()
    const now = new Date().toISOString()

    const newPlayer: any = {
      id: playerId,
      room_id: upperRoomCode,
      name: trimmedName,
      is_admin: false,
      word: "",
      clue: "",
      votes: 0,
      is_eliminated: false,
      score: 0,
      last_seen: now,
      created_at: now,
    }

    room.players.push(newPlayer)
    room.last_activity = now
    playerSessions.set(playerId, { roomId: upperRoomCode, playerId, lastSeen: now })

    console.log(`Player joined (memory): ${trimmedName} (${playerId}) to room ${upperRoomCode}`)
    return { room, playerId }
  }

  static getRoomMemory(roomCode: string): GameRoomWithPlayers | null {
    return gameRooms.get(roomCode.toUpperCase()) || null
  }

  static updateRoomMemory(roomCode: string, updates: Partial<GameRoomWithPlayers>): GameRoomWithPlayers | null {
    const room = gameRooms.get(roomCode.toUpperCase())
    if (!room) return null

    Object.assign(room, updates, { last_activity: new Date().toISOString() })
    return room
  }

  static updatePlayerMemory(roomCode: string, playerId: string, updates: Partial<Player>): GameRoomWithPlayers | null {
    const room = gameRooms.get(roomCode.toUpperCase())
    if (!room) return null

    const playerIndex = room.players.findIndex((p) => p.id === playerId)
    if (playerIndex === -1) return null

    Object.assign(room.players[playerIndex], updates, { last_seen: new Date().toISOString() })
    room.last_activity = new Date().toISOString()

    // Update player session
    const session = playerSessions.get(playerId)
    if (session) {
      session.lastSeen = new Date().toISOString()
    }

    return room
  }

  static removePlayerMemory(roomCode: string, playerId: string): GameRoomWithPlayers | null {
    const room = gameRooms.get(roomCode.toUpperCase())
    if (!room) return null

    const playerName = room.players.find((p) => p.id === playerId)?.name
    room.players = room.players.filter((p) => p.id !== playerId)
    playerSessions.delete(playerId)

    console.log(`Player removed (memory): ${playerName} (${playerId}) from room ${roomCode}`)

    // If no players left, delete room
    if (room.players.length === 0) {
      gameRooms.delete(roomCode)
      console.log(`Room deleted (memory): ${roomCode} (no players left)`)
      return null
    }

    // If admin left, make someone else admin
    if (!room.players.some((p) => p.is_admin) && room.players.length > 0) {
      room.players[0].is_admin = true
      console.log(`New admin (memory): ${room.players[0].name} in room ${roomCode}`)
    }

    room.last_activity = new Date().toISOString()
    return room
  }

  static heartbeatMemory(playerId: string): boolean {
    const session = playerSessions.get(playerId)
    if (!session) return false

    session.lastSeen = new Date().toISOString()

    const room = gameRooms.get(session.roomId)
    if (room) {
      const player = room.players.find((p) => p.id === playerId)
      if (player) {
        player.last_seen = new Date().toISOString()
        room.last_activity = new Date().toISOString()
      }
    }

    return true
  }

  private static generatePlayerId(): string {
    return `player_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  static getBackendType(): string {
    return isSupabaseConfigured() ? "Supabase" : "In-Memory"
  }
}
