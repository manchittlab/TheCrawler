FROM apify/actor-node-playwright-chrome:20

# Copy package files AND the local thecrawler tarball BEFORE npm install,
# so the `file:` dependency in package.json resolves at install time.
COPY package*.json thecrawler-*.tgz ./
RUN npm ci --include=dev

COPY . ./
RUN npm run build

CMD npm start
