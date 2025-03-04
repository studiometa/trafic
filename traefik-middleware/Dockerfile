FROM webdevops/php-apache:8.3

COPY composer.json /
COPY composer.lock /
COPY ./root/.ssh /root/.ssh
COPY auth.config.php /
RUN composer install --no-dev --optimize-autoloader --prefer-dist

# Sync project list every 5th minute
RUN docker-cronjob '*/5 * * * * php /cli/sync.php'

# Stop stale projects every hour
RUN docker-cronjob '33 * * * * php /cli/stop.php'

USER application
COPY ./root/.ssh /home/application/.ssh
