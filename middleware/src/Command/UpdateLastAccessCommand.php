<?php

namespace App\Command;

use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

#[AsCommand(
    name: 'ddev:update-last-access',
    description: 'Update last access time for a given DDEV project'
)]
class UpdateLastAccessCommand extends Command
{
    public function __construct(
        private Redis $redis,
    )
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addArgument('project', InputArgument::REQUIRED, 'The project to update.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $host = $input->getArgument('project');

        if (!$host || !$this->redis->exists($host)) {
            $output->writeln("Invalid $host");
            return Command::INVALID;
        }

        $output->writeln("Updating $host...");
        $project = $this->redis->get($host);
        $project['last_accessed_at'] = time();
        $this->redis->set($host, $project);

        return Command::SUCCESS;
    }
}
