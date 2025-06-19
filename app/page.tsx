"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Users, Plus, Loader2 } from "lucide-react"
import GameRoom from "@/components/game-room"
import { useToast } from "@/hooks/use-toast"
import { GameStore } from "@/lib/game-store"
import { isSupabaseConfigured } from "@/lib/supabase"
import { SetupGuide } from "@/components/setup-guide"

export default function HomePage() {
  const { toast } = useToast()
  const [gameState, setGameState] = useState<"home" | "room">("home")
  const [roomCode, setRoomCode] = useState("")
  const [playerName, setPlayerName] = useState("")
  const [isAdmin, setIsAdmin] = useState(false)
  const [joinCode, setJoinCode] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [isJoining, setIsJoining] = useState(false)

  const createRoom = async () => {
    if (!playerName.trim()) {
      toast({
        title: "Name required",
        description: "Please enter your name to create a room",
        variant: "destructive",
      })
      return
    }

    if (playerName.trim().length < 2) {
      toast({
        title: "Name too short",
        description: "Your name must be at least 2 characters long",
        variant: "destructive",
      })
      return
    }

    setIsCreating(true)

    try {
      // Generate a unique room code
      let code = ""
      let attempts = 0

      // Try to generate a unique code (avoid collisions)
      do {
        code = Math.random().toString(36).substring(2, 8).toUpperCase()
        attempts++

        // Check if room exists
        const existingRoom = await GameStore.getRoom(code)
        if (!existingRoom) break
      } while (attempts < 10)

      if (attempts >= 10) {
        throw new Error("Unable to generate unique room code. Please try again.")
      }

      console.log("Creating room with code:", code)

      // Actually create the room here instead of just setting state
      const result = await GameStore.createRoom(code, playerName.trim())

      if (result) {
        setRoomCode(code)
        setIsAdmin(true)
        setGameState("room")

        toast({
          title: "Room created!",
          description: `Room code: ${code}`,
        })
      } else {
        throw new Error("Failed to create room")
      }
    } catch (error) {
      console.error("Error creating room:", error)
      toast({
        title: "Failed to create room",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      })
    } finally {
      setIsCreating(false)
    }
  }

  const joinRoom = async () => {
    if (!playerName.trim()) {
      toast({
        title: "Name required",
        description: "Please enter your name to join a room",
        variant: "destructive",
      })
      return
    }

    if (!joinCode.trim()) {
      toast({
        title: "Room code required",
        description: "Please enter a room code to join",
        variant: "destructive",
      })
      return
    }

    if (playerName.trim().length < 2) {
      toast({
        title: "Name too short",
        description: "Your name must be at least 2 characters long",
        variant: "destructive",
      })
      return
    }

    if (joinCode.trim().length !== 6) {
      toast({
        title: "Invalid room code",
        description: "Room code must be 6 characters long",
        variant: "destructive",
      })
      return
    }

    setIsJoining(true)

    try {
      const code = joinCode.toUpperCase().trim()
      console.log("Attempting to join room:", code, "as", playerName.trim())

      // Check if room exists first
      const roomExists = await GameStore.getRoom(code)
      if (!roomExists) {
        throw new Error(`Room ${code} not found`)
      }

      setRoomCode(code)
      setIsAdmin(false)
      setGameState("room")

      toast({
        title: "Joining room...",
        description: `Connecting to room ${code}`,
      })
    } catch (error) {
      console.error("Error joining room:", error)
      toast({
        title: "Failed to join room",
        description: error instanceof Error ? error.message : "Please check the room code and try again",
        variant: "destructive",
      })
    } finally {
      setIsJoining(false)
    }
  }

  const handleBack = () => {
    setGameState("home")
    setRoomCode("")
    setJoinCode("")
    setIsAdmin(false)
  }

  if (gameState === "room") {
    return <GameRoom roomCode={roomCode} playerName={playerName.trim()} isAdmin={isAdmin} onLeave={handleBack} />
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-gray-900">Word Detective</h1>
          <p className="text-gray-600">Find the imposters through clever clues!</p>
        </div>

        {/* Setup Guide */}
        <SetupGuide />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Join the Game
            </CardTitle>
            <CardDescription>Enter your name to create or join a room</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="playerName">Your Name</Label>
              <Input
                id="playerName"
                placeholder="Enter your name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                maxLength={20}
                disabled={isCreating || isJoining}
              />
            </div>

            <div className="space-y-3">
              <Button onClick={createRoom} className="w-full" disabled={!playerName.trim() || isCreating || isJoining}>
                {isCreating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating Room...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Create New Room
                  </>
                )}
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-muted-foreground">Or</span>
                </div>
              </div>

              <div className="space-y-2">
                <Input
                  placeholder="Enter room code (6 characters)"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  disabled={isCreating || isJoining}
                />
                <Button
                  onClick={joinRoom}
                  variant="outline"
                  className="w-full"
                  disabled={!playerName.trim() || !joinCode.trim() || isCreating || isJoining}
                >
                  {isJoining ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Joining Room...
                    </>
                  ) : (
                    "Join Room"
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Debug section */}
        <Card className="border-dashed border-gray-300">
          <CardHeader>
            <CardTitle className="text-sm text-gray-500">Debug Info</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-gray-500 space-y-1">
              <p>Backend: {GameStore.getBackendType()}</p>
              <p>Supabase Configured: {isSupabaseConfigured() ? "Yes" : "No"}</p>
            </div>
          </CardContent>
        </Card>

        <div className="text-center text-sm text-gray-500">
          <p>How to play:</p>
          <p>Most players get the same word, but some get different ones.</p>
          <p>Give clues to find the imposters!</p>
        </div>
      </div>
    </div>
  )
}
