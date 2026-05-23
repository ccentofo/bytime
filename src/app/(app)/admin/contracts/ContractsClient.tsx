'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Textarea,
  Select,
  Drawer,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Table,
  ActionIcon,
  Box,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { IconEdit, IconList, IconPlus, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import {
  createContract,
  updateContract,
} from '@/server/actions/contracts';
import { getClinsByContract, createClin, updateClin } from '@/server/actions/clins';
import { getSlinsByClin, createSlin, updateSlin } from '@/server/actions/slins';
import classes from "./Contracts.module.css";

type Contract = {
  id: string;
  contractNumber: string;
  name: string;
  description: string | null;
  contractType: string;
  status: 'active' | 'inactive' | 'closed';
  startDate: Date | null;
  endDate: Date | null;
  fundedValue: string | null;
  ceilingValue: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type Clin = {
  id: string;
  contractId: string;
  clinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};

type Slin = {
  id: string;
  clinId: string;
  slinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};

type ContractForm = {
  contractNumber: string;
  name: string;
  description: string;
  contractType: string;
  startDate: string | null;
  endDate: string | null;
  fundedValue: string;
  ceilingValue: string;
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
  contractType: 'prime',
  startDate: null,
  endDate: null,
  fundedValue: '',
  ceilingValue: '',
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
  const [clinForm, setClinForm] = useState({ clinNumber: '', description: '', fundedAmount: '' });

  // SLINs state
  const [slinsByClin, setSlinsByClin] = useState<Record<string, Slin[]>>({});
  const [slinForm, setSlinForm] = useState({ slinNumber: '', description: '', fundedAmount: '' });
  const [expandedClinId, setExpandedClinId] = useState<string | null>(null);

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
      contractType: contract.contractType ?? 'prime',
      startDate: contract.startDate ? contract.startDate.toISOString().split('T')[0] : null,
      endDate: contract.endDate ? contract.endDate.toISOString().split('T')[0] : null,
      fundedValue: contract.fundedValue ?? '',
      ceilingValue: contract.ceilingValue ?? '',
    });
    setModalOpen(true);
  }

  function openClinsDrawer(contract: Contract) {
    setSelectedContract(contract);
    setDrawerOpen(true);
    setSlinsByClin({});
    setExpandedClinId(null);
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
        contractType: contractForm.contractType || 'prime',
        startDate: contractForm.startDate ? new Date(contractForm.startDate) : undefined,
        endDate: contractForm.endDate ? new Date(contractForm.endDate) : undefined,
        fundedValue: contractForm.fundedValue || undefined,
        ceilingValue: contractForm.ceilingValue || undefined,
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
        fundedAmount: clinForm.fundedAmount || undefined,
      });
      if (created) {
        setClins((prev) => [...prev, created as Clin]);
        setClinForm({ clinNumber: '', description: '', fundedAmount: '' });
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

  function handleExpandClin(clinId: string) {
    if (expandedClinId === clinId) {
      setExpandedClinId(null);
      return;
    }
    setExpandedClinId(clinId);
    if (!slinsByClin[clinId]) {
      startTransition(async () => {
        const data = await getSlinsByClin(clinId);
        setSlinsByClin((prev) => ({ ...prev, [clinId]: data as Slin[] }));
      });
    }
  }

  function handleSlinSubmit(clinId: string) {
    startTransition(async () => {
      const created = await createSlin({
        clinId,
        slinNumber: slinForm.slinNumber,
        description: slinForm.description || undefined,
        fundedAmount: slinForm.fundedAmount || undefined,
      });
      if (created) {
        setSlinsByClin((prev) => ({
          ...prev,
          [clinId]: [...(prev[clinId] ?? []), created as Slin],
        }));
        setSlinForm({ slinNumber: '', description: '', fundedAmount: '' });
      }
    });
  }

  function handleSlinStatusToggle(slin: Slin) {
    const newStatus = slin.status === 'active' ? 'inactive' : 'active';
    startTransition(async () => {
      const updated = await updateSlin(slin.id, { status: newStatus });
      if (updated) {
        setSlinsByClin((prev) => ({
          ...prev,
          [slin.clinId]: (prev[slin.clinId] ?? []).map((s) =>
            s.id === updated.id ? (updated as Slin) : s
          ),
        }));
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
      accessorKey: 'contractType',
      header: 'Type',
      Cell: ({ cell }) => (
        <Badge color={cell.getValue<string>() === 'prime' ? 'blue' : 'grape'} variant="light" size="sm">
          {cell.getValue<string>() === 'prime' ? 'Prime' : 'Sub'}
        </Badge>
      ),
      size: 90,
    },
    {
      accessorKey: 'fundedValue',
      header: 'Funded',
      Cell: ({ cell }) => {
        const val = cell.getValue<string | null>();
        if (!val) return <Text size="sm" c="dimmed">—</Text>;
        const num = parseFloat(val);
        return isNaN(num) ? '—' : `$${num.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      },
      size: 130,
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
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
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
          <Select
            label="Contract Type"
            data={[
              { value: 'prime', label: 'Prime Contract' },
              { value: 'sub', label: 'Subcontract' },
            ]}
            value={contractForm.contractType}
            onChange={(val) => setContractForm((f) => ({ ...f, contractType: val ?? 'prime' }))}
          />
          <TextInput
            label="Funded Value ($)"
            placeholder="500000.00"
            value={contractForm.fundedValue}
            onChange={(e) => setContractForm((f) => ({ ...f, fundedValue: e.target.value }))}
          />
          <TextInput
            label="Ceiling Value ($)"
            placeholder="750000.00"
            value={contractForm.ceilingValue}
            onChange={(e) => setContractForm((f) => ({ ...f, ceilingValue: e.target.value }))}
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
        size="xl"
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
            <TextInput
              label="Funded Amount ($)"
              placeholder="100000.00"
              value={clinForm.fundedAmount}
              onChange={(e) => setClinForm((f) => ({ ...f, fundedAmount: e.target.value }))}
              style={{ minWidth: 150 }}
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
            <Stack gap="xs">
              {clins.map((clin) => (
                <Box key={clin.id}>
                  {/* CLIN row */}
                  <Table striped highlightOnHover withTableBorder>
                    <Table.Tbody>
                      <Table.Tr>
                        <Table.Td style={{ width: 32 }}>
                          <ActionIcon
                            variant="subtle"
                            size="sm"
                            onClick={() => handleExpandClin(clin.id)}
                            title={expandedClinId === clin.id ? 'Collapse SLINs' : 'Expand SLINs'}
                          >
                            {expandedClinId === clin.id
                              ? <IconChevronDown size={14} />
                              : <IconChevronRight size={14} />
                            }
                          </ActionIcon>
                        </Table.Td>
                        <Table.Td fw={600}>{clin.clinNumber}</Table.Td>
                        <Table.Td>{clin.description ?? '—'}</Table.Td>
                        <Table.Td>
                          {clin.fundedAmount ? `$${parseFloat(clin.fundedAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
                        </Table.Td>
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
                    </Table.Tbody>
                  </Table>

                  {/* SLINs section (collapsible) */}
                  {expandedClinId === clin.id && (
                    <Box pl="md" pt="xs" pb="sm" style={{ borderLeft: '2px solid var(--mantine-color-blue-3)', marginLeft: 16 }}>
                      <Title order={6} mb="xs" c="dimmed">SLINs for CLIN {clin.clinNumber}</Title>

                      {/* Add SLIN form */}
                      <Group align="flex-end" mb="xs">
                        <TextInput
                          label="SLIN Number"
                          placeholder="0001AA"
                          value={slinForm.slinNumber}
                          onChange={(e) => setSlinForm((f) => ({ ...f, slinNumber: e.target.value }))}
                          size="xs"
                          style={{ flex: 1 }}
                        />
                        <TextInput
                          label="Description"
                          placeholder="Base Year Labor"
                          value={slinForm.description}
                          onChange={(e) => setSlinForm((f) => ({ ...f, description: e.target.value }))}
                          size="xs"
                          style={{ flex: 2 }}
                        />
                        <TextInput
                          label="Funded ($)"
                          placeholder="50000.00"
                          value={slinForm.fundedAmount}
                          onChange={(e) => setSlinForm((f) => ({ ...f, fundedAmount: e.target.value }))}
                          size="xs"
                          style={{ minWidth: 120 }}
                        />
                        <Button
                          size="xs"
                          onClick={() => handleSlinSubmit(clin.id)}
                          loading={isPending}
                          leftSection={<IconPlus size={12} />}
                          disabled={!slinForm.slinNumber.trim()}
                        >
                          Add SLIN
                        </Button>
                      </Group>

                      {/* SLINs table */}
                      {(slinsByClin[clin.id] ?? []).length === 0 ? (
                        <Text size="xs" c="dimmed">No SLINs yet. Add one above.</Text>
                      ) : (
                        <Table striped highlightOnHover withTableBorder>
                          <Table.Thead>
                            <Table.Tr>
                              <Table.Th>SLIN #</Table.Th>
                              <Table.Th>Description</Table.Th>
                              <Table.Th>Funded</Table.Th>
                              <Table.Th>Status</Table.Th>
                              <Table.Th>Toggle</Table.Th>
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {(slinsByClin[clin.id] ?? []).map((slin) => (
                              <Table.Tr key={slin.id}>
                                <Table.Td>{slin.slinNumber}</Table.Td>
                                <Table.Td>{slin.description ?? '—'}</Table.Td>
                                <Table.Td>
                                  {slin.fundedAmount
                                    ? `$${parseFloat(slin.fundedAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                                    : '—'}
                                </Table.Td>
                                <Table.Td>
                                  <Badge size="xs" color={STATUS_COLORS[slin.status] ?? 'gray'}>{slin.status}</Badge>
                                </Table.Td>
                                <Table.Td>
                                  <Button
                                    size="xs"
                                    variant="subtle"
                                    onClick={() => handleSlinStatusToggle(slin)}
                                    loading={isPending}
                                  >
                                    {slin.status === 'active' ? 'Deactivate' : 'Activate'}
                                  </Button>
                                </Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      )}
                    </Box>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
