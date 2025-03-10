<?php

namespace App\Command;

use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Scheduler\Attribute\AsCronTask;

#[AsCronTask('*/5 * * * *')]
#[AsCommand(
    name: 'ddev:sync',
    description: 'Sync list of configured DDEV projects'
)]
class SyncCommand extends Command
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
        $hosts = [];

        // Update projects missing from Redis
        foreach ($this->ddev->projects() as $project) {
            /** @var string */
            $host = parse_url($project['httpsurl'], PHP_URL_HOST);
            $hosts[] = $this->redis->withPrefix($host);

            if (!$this->redis->exists($host)) {
                $output->writeln("Adding $host...");
                $this->redis->set(
                    $host,
                    [
                        'host' => $host,
                        'name' => $project['name'],
                        'status' => $project['status'],
                        'last_accessed_at' => time(),
                    ]
                );
            }
        }

        // Delete non existing projects from Redis
        foreach($this->redis->keys('*') as $key) {
            if (!in_array($key, $hosts)) {
                $output->writeln("Deleting $key...");
                $this->redis->del($key);
            }
        }

        return Command::SUCCESS;
    }
}
