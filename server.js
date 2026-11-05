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

//connect mongoDB
mongoose
	.connect(process.env.MONGODB_URI)
	.then(() => console.log('MongoDB Connected'))
	.catch((err) => console.error('MongoDB Connection Error', err));

//health check api call
app.get('/api/ping', (req, res) => {
	res.json({
		message: 'PostIt! app is up',
		db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
	});
});

const PORT = process.env.PORT
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
