<?php

namespace App\Command;

use App\Service\Redis;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

#[AsCommand(
    name: 'ddev:clear',
    description: 'Clear data from Redis'
)]
class ClearCommand extends Command
{
    public function __construct(private Redis $redis)
    {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        // Delete non existing projects from Redis
        foreach ($this->redis->keys('*') as $key) {
            $output->writeln("Deleting $key...");
            $this->redis->del($key);
        }

        return Command::SUCCESS;
    }
}
