const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../lib/jwt');

//login api
const login = async(req, res) => {
    try {
        //get email and password from request body
        const{email, password} = req.body || {};

        //check if email and password are provided
        if (typeof email !== 'string' || typeof password !== 'string'
            || !email.trim() || !password)
            {
                return res.status(400).json({
                    error: 'Email and password are required'
                });
            } 
        
        //find user by email
        const user = await User.findOne({
            email: email.trim().toLowerCase()
        });

        //check if user exists and password matches
        if (!user || !(await bcrypt.compare(password, user.password)))
        {
            return res.status(401).json({
                error: 'Invalid email or password'
            });
        }

        //successful login
        const token = signAccessToken(user._id);
        return res.status(200).json({
            message: 'Login successful',
            token,
            user:{
                id: user._id,
                name: user.name,
                email: user.email
            }
        });
  
    } catch (error)
    {
        console.error('Login failed');

        return res.status(500).json({
            error: 'Internal server error'
        });
    }
};

//register api
const register = async (req, res) => {
    try {
        const { name, email, password } = req.body || {};

        //check required fields
        if (
            typeof name !== 'string' ||
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !name.trim() ||
            !email.trim() ||
            !password
        ) {
            return res.status(400).json({
                error: 'Name, email and password are required'
            });
        }

        //normalize email
        const normalizedEmail = email.trim().toLowerCase();

        //check if email already exists
        const existingUser = await User.findOne({
            email: normalizedEmail
        });

        if (existingUser) {
            return res.status(409).json({
                error: 'Email already registered'
            });
        }

        //hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        //create new user
        const user = await User.create({
            name: name.trim(),
            email: normalizedEmail,
            password: hashedPassword
        });

        //successful registration
        return res.status(201).json({
            message: 'Registration successful',
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            }
        });

    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({
                error: 'Email already registered'
            });
        }

        console.error('Register error:', error);

        return res.status(500).json({
            error: 'Internal server error'
        });
    }
};

module.exports = {login, register};