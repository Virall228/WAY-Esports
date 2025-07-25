require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const { validateTelegramWebAppData } = require('./utils/auth');
const { Achievement } = require('./models/Achievement');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch((err) => {
  console.error('MongoDB connection error:', err);
});

// Models
const Match = require('./models/Match');
const User = require('./models/User');
const Tournament = require('./models/Tournament');

// Telegram Bot Setup
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Authentication Middleware
const authenticateUser = async (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) {
    return res.status(401).json({ error: 'No authentication data' });
  }

  if (!validateTelegramWebAppData(initData)) {
    return res.status(401).json({ error: 'Invalid authentication data' });
  }

  // Parse user data from initData
  try {
    const data = new URLSearchParams(initData);
    const user = JSON.parse(data.get('user'));
    req.user = user;
    next();
  } catch (error) {
    console.error('Error parsing user data:', error);
    return res.status(401).json({ error: 'Invalid user data' });
  }
};

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    // Create or update user profile
    const user = await User.findOneAndUpdate(
      { telegramId: msg.from.id.toString() },
      {
        telegramId: msg.from.id.toString(),
        username: msg.from.username || 'Anonymous',
        lastActive: new Date()
      },
      { upsert: true, new: true }
    );
    bot.sendMessage(chatId, 'Welcome to WAY Esports! Click the menu button to open the Mini App.');
  } catch (error) {
    console.error('Error creating user profile:', error);
    bot.sendMessage(chatId, 'Welcome! There was an error setting up your profile. Please try again later.');
  }
});

// Tournament Routes
app.post('/api/tournaments', authenticateUser, async (req, res) => {
  try {
    const tournament = new Tournament({
      ...req.body,
      organizer: req.headers['x-telegram-user-id']
    });
    await tournament.save();
    res.status(201).json(tournament);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/tournaments', authenticateUser, async (req, res) => {
  try {
    const tournaments = await Tournament.find()
      .sort({ startDate: -1 });
    res.json(tournaments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tournaments/:id', authenticateUser, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    res.json(tournament);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tournaments/:id/register', authenticateUser, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.registeredTeams.length >= tournament.maxTeams) {
      return res.status(400).json({ error: 'Tournament is full' });
    }

    const newTeam = {
      name: req.body.teamName,
      players: req.body.players,
      seed: tournament.registeredTeams.length + 1
    };

    tournament.registeredTeams.push(newTeam);
    await tournament.save();
    res.json(tournament);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Функция для рассылки уведомлений игрокам о матче за 10 минут до начала
function scheduleMatchNotifications(tournament, bot) {
  if (!tournament.bracket || !tournament.bracket.rounds) return;
  for (const round of tournament.bracket.rounds) {
    for (const match of round.matches) {
      if (!match.scheduledTime) continue;
      const notifyTime = new Date(match.scheduledTime).getTime() - 10 * 60 * 1000;
      const now = Date.now();
      if (notifyTime > now) {
        setTimeout(async () => {
          // Получить игроков обеих команд
          const team1 = tournament.registeredTeams.find(t => t.name === match.team1.name);
          const team2 = tournament.registeredTeams.find(t => t.name === match.team2.name);
          const allPlayers = [
            ...(team1 ? team1.players : []),
            ...(team2 ? team2.players : [])
          ];
          for (const telegramId of allPlayers) {
            try {
              await bot.sendMessage(
                telegramId,
                `Ваш матч скоро начнётся!\nКомната: ${match.matchId}\nПароль: ${match.password || 'будет объявлен'}\nВремя начала: ${new Date(match.scheduledTime).toLocaleString()}`
              );
            } catch (e) {
              console.error('Ошибка отправки уведомления игроку', telegramId, e);
            }
          }
        }, notifyTime - now);
      }
    }
  }
}

app.post('/api/tournaments/:id/start', authenticateUser, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (!tournament.canStart()) {
      return res.status(400).json({ error: 'Tournament cannot be started at this time' });
    }

    tournament.status = 'in_progress';
    // Передаём параметры для расписания
    tournament.generateBracket(tournament.startDate, tournament.matchFormat || 'bo1');
    await tournament.save();
    scheduleMatchNotifications(tournament, bot);
    res.json(tournament);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/tournaments/:id/matches/update', authenticateUser, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const { roundNumber, matchIndex, team1Score, team2Score } = req.body;
    
    // Update match result using the enhanced method
    tournament.updateMatchResult(roundNumber, matchIndex, team1Score, team2Score);
    
    // If tournament is completed, update stats and distribute prizes
    if (tournament.status === 'completed') {
      const finalMatch = tournament.bracket.rounds[tournament.bracket.rounds.length - 1].matches[0];
      const winningTeam = tournament.registeredTeams.find(team => team.name === finalMatch.winner);
      
      if (winningTeam) {
        // Update winner stats
        for (const playerId of winningTeam.players) {
          await User.findOneAndUpdate(
            { telegramId: playerId },
            { 
              $inc: { 
                'stats.wins': 1,
                'stats.tournamentWins': 1,
                'stats.earnings': tournament.prizePool
              }
            }
          );
        }
      }

      // --- НАЧИСЛЕНИЕ ДОСТИЖЕНИЙ ---
      const achievements = await Achievement.find();
      const users = await User.find();
      for (const user of users) {
        for (const achievement of achievements) {
          const { type, value } = achievement.condition;
          let eligible = false;
          if (type === 'wins' && user.stats.wins >= value) eligible = true;
          if (type === 'tournaments' && user.stats.tournamentsPlayed >= value) eligible = true;
          if (type === 'first_place' && user.stats.tournamentsWon >= value) eligible = true;
          if (eligible) {
            const added = await user.addAchievement(achievement._id);
            if (added) {
              console.log(`Achievement '${achievement.name}' awarded to user ${user.username}`);
            }
          }
        }
      }
      // --- КОНЕЦ БЛОКА ДОСТИЖЕНИЙ ---
    }

    await tournament.save();
    res.json(tournament);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// User Profile Routes
app.get('/api/profile/:telegramId', authenticateUser, async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/profile/:telegramId', authenticateUser, async (req, res) => {
  try {
    const allowedUpdates = ['nickname', 'favoriteGames'];
    const updates = Object.keys(req.body)
      .filter(key => allowedUpdates.includes(key))
      .reduce((obj, key) => {
        obj[key] = req.body[key];
        return obj;
      }, {});

    const user = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      { ...updates, lastActive: new Date() },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Match Routes
app.get('/api/matches', authenticateUser, async (req, res) => {
  try {
    const matches = await Match.find();
    res.json(matches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/matches', authenticateUser, async (req, res) => {
  try {
    const match = new Match(req.body);
    await match.save();
    res.status(201).json(match);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Stats Routes
app.get('/api/stats/:telegramId', authenticateUser, async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user.stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 