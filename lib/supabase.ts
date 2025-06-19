import { createClient } from "@supabase/supabase-js"

// Types for our database
export interface GameRoom {
  id: string
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
  created_at: string
  last_activity: string
}

export interface Player {
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

export interface GameRoomWithPlayers extends GameRoom {
  players: Player[]
}

// Enhanced error reporting for Supabase configuration
export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (typeof window !== "undefined") {
    // Client-side logging for debugging
    if (!url || !key) {
      console.warn("Supabase environment variables missing:", {
        url: url ? "Set" : "Missing",
        key: key ? "Set" : "Missing",
      })
    }
  }

  return !!(url && key)
}

// Lazy-loaded Supabase client with better error handling
let supabaseClient: any = null

export function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Missing environment variables NEXT_PUBLIC_SUPABASE_URL and/or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    )
  }

  if (!supabaseClient) {
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
        // Add global error handler
        global: {
          fetch: (...args) => {
            return fetch(...args).catch((error) => {
              console.error("Supabase fetch error:", error)
              throw error
            })
          },
        },
      })
    } catch (error) {
      console.error("Failed to initialize Supabase client:", error)
      throw new Error(
        `Supabase client initialization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      )
    }
  }

  return supabaseClient
}

// Export a getter function instead of direct client
export const supabase = {
  get client() {
    return getSupabaseClient()
  },
}
