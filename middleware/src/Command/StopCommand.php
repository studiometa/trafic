<?php

namespace App\Command;

use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Scheduler\Attribute\AsCronTask;

#[AsCronTask('* * * * *')]
#[AsCommand(
    name: 'ddev:stop',
    description: 'Stop stale DDEV projects'
)]
class StopCommand extends Command
{
    public function __construct(
        private Redis $redis,
        private DDEV $ddev,
    )
    {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $now = time();
        $delay = 600;

        $is_first_project = true;
        foreach ($this->ddev->projects() as $project) {
            // Only consider running projects
            if ($project['status'] !== 'running') continue;

            // Skip the first project to always keep 1 project running
            // in order to keep the ddev-router alive
            if ($is_first_project) {
                $is_first_project = false;
                continue;
            }

            $host = parse_url($project['httpsurl'], PHP_URL_HOST);
            $last_accessed_at = $this->redis->get($host)['last_accessed_at'];

            if ($now - $last_accessed_at > $delay) {
                $output->writeln("Stopping $host...");
                $output->write($this->ddev->stop($project['name']));
            }
        }

        return Command::SUCCESS;
    }
}
