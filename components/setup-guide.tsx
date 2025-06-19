"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Copy, ExternalLink } from "lucide-react"
import { isSupabaseConfigured } from "@/lib/supabase"

export function SetupGuide() {
  const [isOpen, setIsOpen] = useState(false)
  const isConfigured = isSupabaseConfigured()

  return (
    <Card className={isConfigured ? "border-green-200" : "border-yellow-200"}>
      <CardHeader className={isConfigured ? "bg-green-50" : "bg-yellow-50"}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isConfigured ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-600" />
            )}
            <CardTitle className="text-base">
              {isConfigured ? "Supabase Connected" : "Supabase Setup Required"}
            </CardTitle>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setIsOpen(!isOpen)}>
            {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
        <CardDescription>
          {isConfigured
            ? "Your Supabase connection is configured correctly."
            : "Follow these steps to connect your Supabase database."}
        </CardDescription>
      </CardHeader>
      {isOpen && (
        <>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-2">
              <h3 className="font-medium">1. Create a Supabase Project</h3>
              <p className="text-sm text-gray-600">
                Go to{" "}
                <a
                  href="https://supabase.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline inline-flex items-center"
                >
                  supabase.com <ExternalLink className="h-3 w-3 ml-1" />
                </a>{" "}
                and create a new project.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="font-medium">2. Run the SQL Setup Script</h3>
              <p className="text-sm text-gray-600">
                In your Supabase project, go to the SQL Editor and run the setup script from{" "}
                <code className="bg-gray-100 px-1 py-0.5 rounded">scripts/create-tables.sql</code>
              </p>
              <Button
                variant="outline"
                size="sm"
                className="flex items-center gap-1"
                onClick={() => {
                  const script = document.getElementById("sql-script")?.textContent
                  if (script) {
                    navigator.clipboard.writeText(script)
                    alert("SQL script copied to clipboard!")
                  }
                }}
              >
                <Copy className="h-3 w-3" /> Copy SQL Script
              </Button>
              <div className="hidden" id="sql-script">
                {`-- Create game_rooms table
CREATE TABLE IF NOT EXISTS game_rooms (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{"totalPlayers": 6, "imposterCount": 2, "difficulty": "easy", "roundTime": 10}'::jsonb,
  game_phase TEXT NOT NULL DEFAULT 'lobby',
  current_player_index INTEGER NOT NULL DEFAULT 0,
  time_left INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_activity TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create players table
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  word TEXT DEFAULT '',
  clue TEXT DEFAULT '',
  votes INTEGER NOT NULL DEFAULT 0,
  is_eliminated BOOLEAN NOT NULL DEFAULT false,
  score INTEGER NOT NULL DEFAULT 0,
  last_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS players_room_id_idx ON players(room_id);

-- Enable Row Level Security
ALTER TABLE game_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (for simplicity)
CREATE POLICY "Allow public read access to game_rooms" ON game_rooms FOR SELECT USING (true);
CREATE POLICY "Allow public insert access to game_rooms" ON game_rooms FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access to game_rooms" ON game_rooms FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access to game_rooms" ON game_rooms FOR DELETE USING (true);

CREATE POLICY "Allow public read access to players" ON players FOR SELECT USING (true);
CREATE POLICY "Allow public insert access to players" ON players FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access to players" ON players FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access to players" ON players FOR DELETE USING (true);

-- Create function to clean up old rooms
CREATE OR REPLACE FUNCTION cleanup_old_rooms() RETURNS void AS $$
BEGIN
  -- Delete rooms that haven't been active for 2 hours
  DELETE FROM game_rooms
  WHERE last_activity < NOW() - INTERVAL '2 hours';
  
  -- This will cascade delete associated players due to foreign key constraint
END;
$$ LANGUAGE plpgsql;

-- Create a scheduled job to run cleanup every hour
-- Uncomment this if you have pg_cron extension enabled
-- SELECT cron.schedule('0 * * * *', 'SELECT cleanup_old_rooms()');`}
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-medium">3. Add Environment Variables to Vercel</h3>
              <p className="text-sm text-gray-600">In your Vercel project settings, add these environment variables:</p>
              <div className="bg-gray-50 p-3 rounded-md space-y-2 text-sm">
                <div>
                  <code className="font-bold">NEXT_PUBLIC_SUPABASE_URL</code>
                  <p className="text-gray-600 text-xs mt-1">
                    Your Supabase project URL (found in Project Settings → API)
                  </p>
                </div>
                <div>
                  <code className="font-bold">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
                  <p className="text-gray-600 text-xs mt-1">
                    Your Supabase anon/public key (found in Project Settings → API)
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-medium">4. Redeploy Your Application</h3>
              <p className="text-sm text-gray-600">
                After adding the environment variables, redeploy your application on Vercel.
              </p>
            </div>
          </CardContent>
          <CardFooter className="bg-gray-50">
            <div className="text-xs text-gray-600">
              {isConfigured
                ? "Your Supabase connection is working correctly. If you're still experiencing issues, check the browser console for errors."
                : "After completing these steps, your multiplayer game will be fully functional with persistent storage."}
            </div>
          </CardFooter>
        </>
      )}
    </Card>
  )
}
