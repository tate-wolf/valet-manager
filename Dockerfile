# Use an official Node 18 image based on Debian Bullseye which includes Python
FROM node:18-bullseye

# Set the working directory inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./

# Configure npm to use Python3 (for node-gyp) and install dependencies
RUN npm config set python /usr/bin/python3 && npm install --build-from-source

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
