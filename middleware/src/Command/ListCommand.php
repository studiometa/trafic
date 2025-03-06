<?php

namespace App\Command;

use App\Service\Redis;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Helper\Table;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

#[AsCommand(
    name: 'ddev:list',
    description: 'List synced DDEV projects'
)]
class ListCommand extends Command
{
    public function __construct(
        private Redis $redis,
    )
    {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $rows = [];

        foreach ($this->redis->keys('*') as $key) {
            $project = $this->redis->get($key);
            $rows[] = array_values($project);
        }

        $table = new Table($output);
        $table
            ->setHeaders(['Host', 'Name', 'Status', 'Last Accessed At'])
            ->setRows($rows);
        $table->render();

        return Command::SUCCESS;
    }
}
