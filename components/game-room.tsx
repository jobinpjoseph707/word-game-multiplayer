"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import {
  Users,
  Settings,
  Play,
  Copy,
  Crown,
  Clock,
  MessageCircle,
  Vote,
  AlertCircle,
  Loader2,
  RefreshCw,
  Database,
  Server,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useMultiplayer } from "@/hooks/use-multiplayer"

interface GameRoomProps {
  roomCode: string
  playerName: string
  isAdmin: boolean
  onLeave: () => void
}

export default function GameRoom({ roomCode, playerName, isAdmin, onLeave }: GameRoomProps) {
  const { toast } = useToast()
  const {
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
  } = useMultiplayer(roomCode, playerName, isAdmin)

  const [currentClue, setCurrentClue] = useState("")
  const [selectedVote, setSelectedVote] = useState<string>("")
  const [timeLeft, setTimeLeft] = useState(0)

  // Handle connection errors
  useEffect(() => {
    if (error) {
      toast({
        title: "Game Update Error", // More generic title
        description: error, // The error message from useMultiplayer
        variant: "destructive",
      })
    }
  }, [error, toast])

  // Timer logic
  useEffect(() => {
    if (room && room.time_left > 0) {
      setTimeLeft(room.time_left)
      const timer = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(timer)
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(timer)
    }
  }, [room])

  // Periodic cleanup of inactive players
  useEffect(() => {
    if (!isAdmin) return // Only admin handles cleanup

    const cleanupInterval = setInterval(async () => {
      if (room && room.game_phase === "lobby") {
        // Clean up inactive players in Supabase
        if (backendType === "Supabase") {
          try {
            const { getSupabaseClient } = await import("@/lib/supabase")
            const supabase = getSupabaseClient()
            const cutoffTime = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 minutes ago

            // Remove players who haven't been seen for 2 minutes
            await supabase
              .from("players")
              .delete()
              .eq("room_id", roomCode)
              .lt("last_seen", cutoffTime)
              .neq("is_admin", true) // Don't remove admin

            console.log("Cleaned up inactive players")
          } catch (error) {
            console.error("Cleanup error:", error)
          }
        }
      }
    }, 60000) // Run cleanup every minute

    return () => clearInterval(cleanupInterval)
  }, [isAdmin, room, roomCode, backendType])

  // Add this useEffect to track room changes:
  useEffect(() => {
    if (room) {
      console.log(
        `Room updated: ${room.players.length} players`,
        room.players.map((p) => p.name),
      )
    }
  }, [room])

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode)
    toast({
      title: "Room code copied!",
      description: "Share this code with your friends",
    })
  }

  const handleStartGame = async () => {
    const success = await startGame()
    if (!success && room && room.players.length < 3) {
      toast({
        title: "Need more players",
        description: "At least 3 players are required to start",
        variant: "destructive",
      })
    }
  }

  const handleSubmitClue = async () => {
    if (!currentClue.trim()) {
      toast({
        title: "Clue required",
        description: "Please enter a clue before submitting",
        variant: "destructive",
      })
      return
    }

    const success = await submitClue(currentClue)
    if (success) {
      setCurrentClue("")
    }
  }

  const handleSubmitVote = async () => {
    if (!selectedVote) {
      toast({
        title: "Vote required",
        description: "Please select a player to vote for",
        variant: "destructive",
      })
      return
    }

    const success = await submitVote(selectedVote)
    if (success) {
      setSelectedVote("")
    }
  }

  const handleLeave = async () => {
    await leaveRoom()
    onLeave()
  }

  const handleRetry = () => {
    retry()
  }

  // Loading state
  if (isConnecting) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <Loader2 className="w-12 h-12 mx-auto text-blue-500 animate-spin" />
              <h2 className="text-2xl font-bold">{isAdmin ? "Creating Room..." : "Joining Room..."}</h2>
              <p className="text-gray-600">
                {isAdmin ? `Setting up room ${roomCode}` : `Connecting to room ${roomCode}`}
              </p>
              <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                {backendType === "Supabase" ? <Database className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                <span>Backend: {backendType}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Error state
  if (!isConnected || error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-pink-100 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <AlertCircle className="w-12 h-12 mx-auto text-red-500" />
              <h2 className="text-2xl font-bold">Connection Issue</h2>
              <p className="text-gray-600">{error || "Unable to connect to the game room"}</p>
              <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                {backendType === "Supabase" ? <Database className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                <span>Backend: {backendType}</span>
              </div>
              <div className="flex gap-2 justify-center">
                <Button onClick={handleRetry} variant="outline">
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry
                </Button>
                <Button onClick={onLeave}>Back to Home</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!room) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <Loader2 className="w-12 h-12 mx-auto text-gray-500 animate-spin" />
              <h2 className="text-2xl font-bold">Loading Room...</h2>
              <p className="text-gray-600">Please wait while we load the game room</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const myPlayer = room.players.find((p) => p.id === playerId)
  const currentPlayer = room.players[room.current_player_index]

  if (room.game_phase === "lobby") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Word Detective</h1>
              <p className="text-gray-600">Room: {roomCode}</p>
              <div className="flex items-center gap-2 mt-1">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span className="text-sm text-green-600">Connected via {backendType}</span>
                {backendType === "In-Memory" && (
                  <Badge variant="outline" className="text-xs">
                    Demo Mode
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={copyRoomCode}>
                <Copy className="w-4 h-4 mr-2" />
                Copy Code
              </Button>
              <Button variant="outline" onClick={handleLeave}>
                Leave Room
              </Button>
            </div>
          </div>

          {/* Backend Notice */}
          {backendType === "In-Memory" && (
            <Card className="border-yellow-200 bg-yellow-50">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-yellow-800">Demo Mode Active</p>
                    <p className="text-sm text-yellow-700">
                      Running in demo mode with in-memory storage. For full multiplayer functionality across devices,
                      please configure Supabase environment variables.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            {/* Players List */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Players ({room.players.length}/{room.settings.totalPlayers})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {room.players.map((player, index) => (
                    <div
                      key={`${player.id}-${index}`}
                      className="flex items-center justify-between p-2 bg-gray-50 rounded"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{player.name}</span>
                        {player.is_admin && <Crown className="w-4 h-4 text-yellow-500" />}
                      </div>
                      <Badge variant={player.name === playerName ? "default" : "secondary"}>
                        {player.name === playerName ? "You" : "Player"}
                      </Badge>
                    </div>
                  ))}
                </div>

                {room.players.length < 3 && (
                  <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <p className="text-sm text-yellow-800">
                      Need at least 3 players to start the game. Share the room code with your friends!
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Game Settings */}
            {isAdmin && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Settings className="w-5 h-5" />
                    Game Settings
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Total Players</Label>
                    <Select
                      value={room.settings.totalPlayers.toString()}
                      onValueChange={(value) => updateSettings({ totalPlayers: Number.parseInt(value) })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="4">4 Players</SelectItem>
                        <SelectItem value="5">5 Players</SelectItem>
                        <SelectItem value="6">6 Players</SelectItem>
                        <SelectItem value="7">7 Players</SelectItem>
                        <SelectItem value="8">8 Players</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Imposters</Label>
                    <Select
                      value={room.settings.imposterCount.toString()}
                      onValueChange={(value) => updateSettings({ imposterCount: Number.parseInt(value) })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 Imposter</SelectItem>
                        <SelectItem value="2">2 Imposters</SelectItem>
                        <SelectItem value="3">3 Imposters</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Difficulty</Label>
                    <Select
                      value={room.settings.difficulty}
                      onValueChange={(value: "easy" | "medium" | "hard") => updateSettings({ difficulty: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="easy">Easy</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="hard">Hard</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Button onClick={handleStartGame} className="w-full" disabled={room.players.length < 3}>
                    <Play className="w-4 h-4 mr-2" />
                    Start Game
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Game Rules */}
          <Card>
            <CardHeader>
              <CardTitle>How to Play</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4 text-sm">
                <div>
                  <h4 className="font-semibold mb-2">For Majority Players:</h4>
                  <ul className="space-y-1 text-gray-600">
                    <li>• You have the common word</li>
                    <li>• Give clues to help others identify you</li>
                    <li>• Find and vote out the imposters</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold mb-2">For Imposters:</h4>
                  <ul className="space-y-1 text-gray-600">
                    <li>• You have a different but related word</li>
                    <li>• Listen to clues and try to blend in</li>
                    <li>• Avoid getting voted out</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  if (room.game_phase === "starting") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">Game Starting!</h2>
              <div className="text-6xl font-bold text-green-600">{timeLeft}</div>
              <div className="space-y-2">
                <p className="text-lg font-semibold">Your word is:</p>
                <div className="text-3xl font-bold bg-yellow-100 p-4 rounded-lg border-2 border-yellow-300">
                  {myPlayer?.word}
                </div>
                <p className="text-sm text-gray-600">Remember this word and give good clues!</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (room.game_phase === "clues") {
    const isMyTurn = currentPlayer?.id === playerId

    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100 p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">Giving Clues - Round {room.round}</h2>
              <p className="text-gray-600">Each player gives one clue about their word</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span className="font-mono text-lg">{timeLeft}s</span>
              </div>
              <Badge>Your word: {myPlayer?.word}</Badge>
            </div>
          </div>

          {/* Progress */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Progress</span>
              <span>
                {room.current_player_index + 1} / {room.players.length}
              </span>
            </div>
            <Progress value={((room.current_player_index + 1) / room.players.length) * 100} />
          </div>

          {/* Current Turn */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageCircle className="w-5 h-5" />
                {isMyTurn ? "Your Turn!" : `${currentPlayer?.name}'s Turn`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isMyTurn ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>
                      Give a one-word clue about: <strong>{myPlayer?.word}</strong>
                    </Label>
                    <Input
                      placeholder="Enter your clue..."
                      value={currentClue}
                      onChange={(e) => setCurrentClue(e.target.value)}
                      maxLength={20}
                      onKeyPress={(e) => e.key === "Enter" && handleSubmitClue()}
                    />
                  </div>
                  <Button onClick={handleSubmitClue} disabled={!currentClue.trim()}>
                    Submit Clue
                  </Button>
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="text-lg">
                    Waiting for <strong>{currentPlayer?.name}</strong> to give their clue...
                  </div>
                  <div className="mt-2 text-sm text-gray-600">
                    Think about what clue you'll give for: <strong>{myPlayer?.word}</strong>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Previous Clues */}
          {room.players.some((p) => p.clue) && (
            <Card>
              <CardHeader>
                <CardTitle>Clues Given So Far</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2">
                  {room.players
                    .filter((p) => p.clue)
                    .map((player) => (
                      <div key={player.id} className="flex justify-between items-center p-2 bg-gray-50 rounded">
                        <span className="font-medium">{player.name}</span>
                        <Badge variant="outline">{player.clue}</Badge>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    )
  }

  if (room.game_phase === "discussion") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-red-100 p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">Discussion Time</h2>
              <p className="text-gray-600">Discuss the clues and decide who to vote for</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span className="font-mono text-lg">{timeLeft}s</span>
              </div>
            </div>
          </div>

          {/* All Clues */}
          <Card>
            <CardHeader>
              <CardTitle>All Clues</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {room.players.map((player) => (
                  <div key={player.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{player.name}</span>
                      {player.name === playerName && <Badge variant="secondary">You</Badge>}
                    </div>
                    <div className="text-lg font-semibold">
                      {player.clue || <span className="text-gray-400 italic">No clue given</span>}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Discussion Tips */}
          <Card>
            <CardHeader>
              <CardTitle>Discussion Tips</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4 text-sm">
                <div>
                  <h4 className="font-semibold mb-2">Look for:</h4>
                  <ul className="space-y-1 text-gray-600">
                    <li>• Clues that don't fit with the others</li>
                    <li>• Players who seem confused</li>
                    <li>• Vague or generic clues</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold mb-2">Remember:</h4>
                  <ul className="space-y-1 text-gray-600">
                    <li>• There are {room.settings.imposterCount} imposters</li>
                    <li>• Imposters have a related but different word</li>
                    <li>• Vote carefully!</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="text-center">
            <Button onClick={() => {}} size="lg">
              <Vote className="w-4 h-4 mr-2" />
              Ready to Vote
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (room.game_phase === "voting") {
    const activePlayers = room.players.filter((p) => !p.isEliminated)

    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-pink-100 p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold">Voting Time</h2>
            <p className="text-gray-600">Vote for who you think has a different word</p>
            <div className="flex justify-center gap-4">
              <Badge>Active Players: {activePlayers.length}</Badge>
              <Badge variant="destructive">Eliminated: {room.players.filter((p) => p.isEliminated).length}</Badge>
            </div>
          </div>

          {/* Voting */}
          <Card>
            <CardHeader>
              <CardTitle>Cast Your Vote</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {activePlayers
                  .filter((p) => p.id !== playerId)
                  .map((player) => (
                    <div
                      key={player.id}
                      className={`flex items-center justify-between p-3 border-2 rounded-lg cursor-pointer transition-colors ${
                        selectedVote === player.id
                          ? "border-red-500 bg-red-50"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                      onClick={() => setSelectedVote(player.id)}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-4 h-4 rounded-full border-2 ${
                            selectedVote === player.id ? "bg-red-500 border-red-500" : "border-gray-300"
                          }`}
                        />
                        <span className="font-medium">{player.name}</span>
                      </div>
                      <Badge variant="outline">{player.clue || "No clue"}</Badge>
                    </div>
                  ))}
              </div>

              <div className="mt-6">
                <Button onClick={handleSubmitVote} disabled={!selectedVote} className="w-full" size="lg">
                  Submit Vote
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Show eliminated players */}
          {room.players.some((p) => p.isEliminated) && (
            <Card>
              <CardHeader>
                <CardTitle>Eliminated Players</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {room.players
                    .filter((p) => p.isEliminated)
                    .map((player) => (
                      <Badge key={player.id} variant="secondary" className="opacity-50">
                        {player.name}
                      </Badge>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    )
  }

  if (room.game_phase === "results") {
    const activePlayers = room.players.filter((p) => !p.isEliminated)
    const eliminatedPlayers = room.players.filter((p) => p.isEliminated)

    // Determine word assignments
    const currentWords = [...new Set(room.players.map((p) => p.word))]
    const wordCounts = currentWords.map((word) => ({
      word,
      count: room.players.filter((p) => p.word === word).length,
    }))
    const majorityWord = wordCounts.reduce((a, b) => (a.count > b.count ? a : b)).word
    const minorityWord = currentWords.find((w) => w !== majorityWord)

    const activeImposters = activePlayers.filter((p) => p.word === minorityWord)
    const activeMajority = activePlayers.filter((p) => p.word === majorityWord)

    const majorityWins = activeImposters.length === 0
    const impostersWin = activeMajority.length <= activeImposters.length

    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-100 p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="text-center space-y-4">
            <h2 className="text-3xl font-bold">Game Over!</h2>
            <div className="text-6xl">{majorityWins ? "🎉" : "😈"}</div>
            <div className="text-2xl font-bold">{majorityWins ? "Majority Team Wins!" : "Imposters Win!"}</div>
            <p className="text-gray-600">
              {majorityWins ? "All imposters have been eliminated!" : "Imposters have taken control!"}
            </p>
          </div>

          {/* Word Reveal */}
          <Card>
            <CardHeader>
              <CardTitle>Word Reveal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <h3 className="font-semibold text-blue-800">Majority Word</h3>
                  <div className="text-2xl font-bold text-blue-600">{majorityWord}</div>
                  <p className="text-sm text-blue-600 mt-1">
                    {room.players.filter((p) => p.word === majorityWord).length} players
                  </p>
                </div>
                <div className="text-center p-4 bg-red-50 rounded-lg">
                  <h3 className="font-semibold text-red-800">Imposter Word</h3>
                  <div className="text-2xl font-bold text-red-600">{minorityWord}</div>
                  <p className="text-sm text-red-600 mt-1">
                    {room.players.filter((p) => p.word === minorityWord).length} players
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Player Results */}
          <Card>
            <CardHeader>
              <CardTitle>Final Results</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold text-green-600 mb-2">Surviving Players</h4>
                  <div className="space-y-2">
                    {activePlayers.map((player) => (
                      <div
                        key={player.id}
                        className={`flex items-center justify-between p-3 rounded-lg ${
                          player.word === minorityWord
                            ? "bg-red-50 border border-red-200"
                            : "bg-blue-50 border border-blue-200"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{player.name}</span>
                          {player.name === playerName && <Badge>You</Badge>}
                          <Badge variant={player.word === minorityWord ? "destructive" : "default"}>
                            {player.word === minorityWord ? "Imposter" : "Majority"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm">
                            Word: <strong>{player.word}</strong>
                          </span>
                          <span className="text-sm">
                            Clue: <strong>{player.clue || "None"}</strong>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {eliminatedPlayers.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-red-600 mb-2">Eliminated Players</h4>
                    <div className="space-y-2">
                      {eliminatedPlayers.map((player) => (
                        <div
                          key={player.id}
                          className="flex items-center justify-between p-3 rounded-lg bg-gray-100 opacity-75"
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-medium line-through">{player.name}</span>
                            {player.name === playerName && <Badge>You</Badge>}
                            <Badge variant={player.word === minorityWord ? "destructive" : "default"}>
                              {player.word === minorityWord ? "Imposter" : "Majority"}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-sm">
                              Word: <strong>{player.word}</strong>
                            </span>
                            <span className="text-sm">
                              Votes: <strong>{player.votes}</strong>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex justify-center gap-4">
            <Button variant="outline" onClick={handleLeave} size="lg">
              Leave Game
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return <div>Game phase: {room.game_phase}</div>
}
