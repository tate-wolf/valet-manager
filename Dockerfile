# Use an official Node 18 image based on Debian Bullseye which includes Python
FROM node:18-bullseye

# Set the working directory inside the container
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Set the PYTHON environment variable so node-gyp can find Python3
ENV PYTHON=/usr/bin/python3

# Install dependencies, forcing a rebuild of native modules if needed
RUN npm install --build-from-source

# Copy the rest of your application code
COPY . .

# Expose the port your app listens on
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
