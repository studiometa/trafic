FROM webdevops/php:8.3 AS deps

COPY composer.json /
COPY composer.lock /
RUN composer install --no-dev --optimize-autoloader --prefer-dist

FROM webdevops/php-nginx:8.3

WORKDIR /app
COPY --from=deps /vendor /app/vendor
COPY . .
RUN chown -R application:application /app
ENV APP_ENV=prod

# Sync project list every 5th minute
RUN docker-cronjob '*/5 * * * * php /cli/sync.php'

# Stop stale projects every hour
RUN docker-cronjob '33 * * * * php /cli/stop.php'

# @todo add SSH key to allow access to server
# USER application
# COPY ./root/.ssh /home/application/.ssh
