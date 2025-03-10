<?php

namespace App\Command;

use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Scheduler\Attribute\AsCronTask;

#[AsCronTask('33 * * * *')]
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
        $delay = 3600 * 4;
        $delay = 10; // tmp value

        foreach ($this->redis->keys('*') as $key) {
            $project = json_decode($this->redis->get($key), true);
            $project_name = $project['name'];

            if ($now - $project['last_accessed_at'] > $delay) {
                $output->writeln("Stopping $key...");
                $output->write($this->ddev->stop($project_name));
            }
        }

        return Command::SUCCESS;
    }
}
