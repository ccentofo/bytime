'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Textarea,
  Drawer,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Table,
  ActionIcon,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { IconEdit, IconList, IconPlus } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import {
  createContract,
  updateContract,
} from '@/server/actions/contracts';
import { getClinsByContract, createClin, updateClin } from '@/server/actions/clins';

type Contract = {
  id: string;
  contractNumber: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Clin = {
  id: string;
  contractId: string;
  clinNumber: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};

type ContractForm = {
  contractNumber: string;
  name: string;
  description: string;
  startDate: string | null;
  endDate: string | null;
};

type Props = {
  initialContracts: Contract[];
};

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  inactive: 'gray',
  closed: 'red',
};

const EMPTY_FORM: ContractForm = {
  contractNumber: '',
  name: '',
  description: '',
  startDate: null,
  endDate: null,
};

export function ContractsClient({ initialContracts }: Props) {
  const [contracts, setContracts] = useState<Contract[]>(initialContracts);
  const [isPending, startTransition] = useTransition();

  // Contract modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<Contract | null>(null);
  const [contractForm, setContractForm] = useState<ContractForm>(EMPTY_FORM);

  // CLINs drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedContract, setSelectedContract] = useState<Contract | null>(null);
  const [clins, setClins] = useState<Clin[]>([]);
  const [clinForm, setClinForm] = useState({ clinNumber: '', description: '' });

  function openAddModal() {
    setEditingContract(null);
    setContractForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEditModal(contract: Contract) {
    setEditingContract(contract);
    setContractForm({
      contractNumber: contract.contractNumber,
      name: contract.name,
      description: contract.description ?? '',
      startDate: contract.startDate ? contract.startDate.toISOString().split('T')[0] : null,
      endDate: contract.endDate ? contract.endDate.toISOString().split('T')[0] : null,
    });
    setModalOpen(true);
  }

  function openClinsDrawer(contract: Contract) {
    setSelectedContract(contract);
    setDrawerOpen(true);
    startTransition(async () => {
      const data = await getClinsByContract(contract.id);
      setClins(data as Clin[]);
    });
  }

  function handleContractSubmit() {
    startTransition(async () => {
      const payload = {
        contractNumber: contractForm.contractNumber,
        name: contractForm.name,
        description: contractForm.description || undefined,
        startDate: contractForm.startDate ? new Date(contractForm.startDate) : undefined,
        endDate: contractForm.endDate ? new Date(contractForm.endDate) : undefined,
      };

      if (editingContract) {
        const updated = await updateContract(editingContract.id, payload);
        if (updated) {
          setContracts((prev) =>
            prev.map((c) => (c.id === updated.id ? (updated as Contract) : c))
          );
        }
      } else {
        const created = await createContract(payload);
        if (created) {
          setContracts((prev) => [...prev, created as Contract]);
        }
      }
      setModalOpen(false);
    });
  }

  function handleClinSubmit() {
    if (!selectedContract) return;
    startTransition(async () => {
      const created = await createClin({
        contractId: selectedContract.id,
        clinNumber: clinForm.clinNumber,
        description: clinForm.description || undefined,
      });
      if (created) {
        setClins((prev) => [...prev, created as Clin]);
        setClinForm({ clinNumber: '', description: '' });
      }
    });
  }

  function handleClinStatusToggle(clin: Clin) {
    const newStatus = clin.status === 'active' ? 'inactive' : 'active';
    startTransition(async () => {
      const updated = await updateClin(clin.id, { status: newStatus });
      if (updated) {
        setClins((prev) => prev.map((c) => (c.id === updated.id ? (updated as Clin) : c)));
      }
    });
  }

  const columns: MRT_ColumnDef<Contract>[] = [
    { accessorKey: 'contractNumber', header: 'Contract Number', size: 160 },
    { accessorKey: 'name', header: 'Name' },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => (
        <Badge color={STATUS_COLORS[cell.getValue<string>()] ?? 'gray'}>
          {cell.getValue<string>()}
        </Badge>
      ),
      size: 110,
    },
    {
      accessorKey: 'startDate',
      header: 'Start Date',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? new Date(val).toLocaleDateString() : '—';
      },
      size: 120,
    },
    {
      accessorKey: 'endDate',
      header: 'End Date',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? new Date(val).toLocaleDateString() : '—';
      },
      size: 120,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: contracts,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap">
        <ActionIcon
          variant="subtle"
          onClick={() => openEditModal(row.original)}
          title="Edit"
        >
          <IconEdit size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          onClick={() => openClinsDrawer(row.original)}
          title="Manage CLINs"
        >
          <IconList size={16} />
        </ActionIcon>
      </Group>
    ),
    renderTopToolbarCustomActions: () => (
      <Button leftSection={<IconPlus size={16} />} onClick={openAddModal}>
        Add Contract
      </Button>
    ),
  });

  // DateInput in @mantine/dates v9 uses string values (ISO date strings) when valueFormat is not set
  // The onChange callback receives string | null
  const handleStartDateChange = (val: string | null) =>
    setContractForm((f) => ({ ...f, startDate: val }));
  const handleEndDateChange = (val: string | null) =>
    setContractForm((f) => ({ ...f, endDate: val }));

  return (
    <>
      <Title order={2} mb="md">Contracts & CLINs</Title>
      <MantineReactTable table={table} />

      {/* Add / Edit Contract Modal */}
      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingContract ? 'Edit Contract' : 'Add Contract'}
        size="md"
      >
        <Stack>
          <TextInput
            label="Contract Number"
            required
            value={contractForm.contractNumber}
            onChange={(e) => setContractForm((f) => ({ ...f, contractNumber: e.target.value }))}
          />
          <TextInput
            label="Name"
            required
            value={contractForm.name}
            onChange={(e) => setContractForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Textarea
            label="Description"
            value={contractForm.description}
            onChange={(e) => setContractForm((f) => ({ ...f, description: e.target.value }))}
          />
          <DateInput
            label="Start Date"
            value={contractForm.startDate}
            onChange={handleStartDateChange}
            clearable
          />
          <DateInput
            label="End Date"
            value={contractForm.endDate}
            onChange={handleEndDateChange}
            clearable
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleContractSubmit} loading={isPending}>
              {editingContract ? 'Save Changes' : 'Create Contract'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* CLINs Drawer */}
      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="lg"
        title={
          selectedContract
            ? `CLINs — ${selectedContract.name} (${selectedContract.contractNumber})`
            : 'CLINs'
        }
      >
        <Stack>
          {/* Add CLIN form */}
          <Title order={5}>Add CLIN</Title>
          <Group align="flex-end">
            <TextInput
              label="CLIN Number"
              value={clinForm.clinNumber}
              onChange={(e) => setClinForm((f) => ({ ...f, clinNumber: e.target.value }))}
              style={{ flex: 1 }}
            />
            <TextInput
              label="Description"
              value={clinForm.description}
              onChange={(e) => setClinForm((f) => ({ ...f, description: e.target.value }))}
              style={{ flex: 2 }}
            />
            <Button onClick={handleClinSubmit} loading={isPending} leftSection={<IconPlus size={14} />}>
              Add
            </Button>
          </Group>

          {/* CLINs list */}
          <Title order={5} mt="sm">Existing CLINs</Title>
          {clins.length === 0 ? (
            <Text c="dimmed" size="sm">No CLINs yet for this contract.</Text>
          ) : (
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>CLIN #</Table.Th>
                  <Table.Th>Description</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Toggle</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {clins.map((clin) => (
                  <Table.Tr key={clin.id}>
                    <Table.Td>{clin.clinNumber}</Table.Td>
                    <Table.Td>{clin.description ?? '—'}</Table.Td>
                    <Table.Td>
                      <Badge color={STATUS_COLORS[clin.status] ?? 'gray'}>{clin.status}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => handleClinStatusToggle(clin)}
                        loading={isPending}
                      >
                        {clin.status === 'active' ? 'Deactivate' : 'Activate'}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
