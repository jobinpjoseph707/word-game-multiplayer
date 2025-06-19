-- Create tables for the multiplayer word game

-- Game rooms table
CREATE TABLE IF NOT EXISTS game_rooms (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{"totalPlayers": 6, "imposterCount": 2, "difficulty": "easy", "roundTime": 10}',
  game_phase TEXT NOT NULL DEFAULT 'lobby' CHECK (game_phase IN ('lobby', 'starting', 'clues', 'discussion', 'voting', 'results')),
  current_player_index INTEGER NOT NULL DEFAULT 0,
  time_left INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Players table
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  word TEXT DEFAULT '',
  clue TEXT DEFAULT '',
  votes INTEGER NOT NULL DEFAULT 0,
  is_eliminated BOOLEAN NOT NULL DEFAULT FALSE,
  score INTEGER NOT NULL DEFAULT 0,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_players_room_id ON players(room_id);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen);
CREATE INDEX IF NOT EXISTS idx_game_rooms_last_activity ON game_rooms(last_activity);

-- Enable Row Level Security
ALTER TABLE game_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;

-- Create policies to allow all operations (since this is a game, we'll allow public access)
CREATE POLICY "Allow all operations on game_rooms" ON game_rooms FOR ALL USING (true);
CREATE POLICY "Allow all operations on players" ON players FOR ALL USING (true);
