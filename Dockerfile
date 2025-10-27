# Use an official Node.js runtime as a parent image.
# Using alpine for a smaller image size.
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if it exists) to leverage Docker's layer caching.
# This step will only be re-run if these files change.
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the rest of your application's source code from your host to your image filesystem.
COPY . .

# The server listens on port 3000 by default, but this can be overridden by the PORT environment variable.
# This line informs Docker that the container listens on the specified network port at runtime.
EXPOSE 3000

# Define the command to run the application
CMD [ "npm", "start" ]