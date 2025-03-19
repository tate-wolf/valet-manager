# Use an official Node 18 image based on Debian Bullseye which includes Python
FROM node:18-bullseye

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Set the PYTHON environment variable so node-gyp can find Python3
ENV PYTHON=/usr/bin/python3

# Install dependencies and force rebuild of native modules
RUN npm install --build-from-source && npm rebuild sqlite3 --build-from-source

# Copy the rest of your application code
COPY . .

# Expose port 3000 (or whichever port your app listens on)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
