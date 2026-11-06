const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json());
// login API route
const authRoutes = require('./routes/auth');
app.use('/api', authRoutes);
app.use('/api/users', require('./routes/users'));
app.use('/api/boards', require('./routes/boards'));

// Item CRUD API routes
const itemRoutes = require('./routes/items');
app.use('/api/items', itemRoutes);

// Email/SMS Reminder API routes
const reminderRoutes = require('./routes/reminders');
app.use('/api/reminders', reminderRoutes);

// Optional worker; mock delivery is the default and never contacts providers.
let reminderWorker;
//connect mongoDB
mongoose
	.connect(process.env.MONGODB_URI)
	.then(async () => {
    console.log('MongoDB Connected');
    if (process.env.REMINDER_WORKER_ENABLED === 'true') {
      await require('./models/Reminder').init();
      reminderWorker = require('./workers/reminderWorker').createReminderWorker();
      reminderWorker.start();
    }
  })
	.catch(() => console.error('Database connection or Reminder worker startup failed'));

//health check api call
app.get('/api/ping', (req, res) => {
	res.json({
		message: 'PostIt! app is up',
		db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
	});
});

const PORT = process.env.PORT
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
