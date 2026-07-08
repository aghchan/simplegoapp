package postgres

import (
	"errors"
	"net"
	"testing"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type testRecord struct {
	Id    int    `gorm:"primaryKey"`
	Name  string `gorm:"type:varchar(50);uniqueIndex"`
	Count int
}

func newTestService(t *testing.T) Service {
	t.Helper()

	conn, err := net.DialTimeout("tcp", "localhost:5434", time.Second)
	if err != nil {
		t.Skip("postgres not running on :5434; start with: " +
			"docker run -d --rm --name simplegoapp-test-pg -e POSTGRES_PASSWORD=password -e POSTGRES_DB=simplegoapp_test -p 5434:5432 postgres:16-alpine")
	}
	conn.Close()

	svc := NewService(
		map[string]interface{}{
			"postgres_user":     "postgres",
			"postgres_password": "password",
			"postgres_host":     "localhost",
			"postgres_port":     "5434",
			"postgres_database": "simplegoapp_test",
		},
		logger.NewService(),
	)
	svc.RunMigrations([]interface{}{&testRecord{}})
	if err := svc.(*service).db.Exec("TRUNCATE TABLE test_records").Error; err != nil {
		t.Fatalf("truncating test table: %v", err)
	}

	return svc
}

func TestFindWithConditions(t *testing.T) {
	svc := newTestService(t)

	seed := []testRecord{
		{Name: "a", Count: 1},
		{Name: "b", Count: 2},
		{Name: "c", Count: 2},
	}
	if err := svc.Insert(&seed); err != nil {
		t.Fatalf("insert: %v", err)
	}

	var got []testRecord
	if err := svc.Find(&got, "count = ?", 2); err != nil {
		t.Fatalf("find with condition: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 rows with count=2, got %d", len(got))
	}

	var all []testRecord
	if err := svc.Find(&all); err != nil {
		t.Fatalf("find all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 rows total, got %d", len(all))
	}
}

func TestUpsertInsertsAndUpdates(t *testing.T) {
	svc := newTestService(t)

	rows := []testRecord{{Name: "a", Count: 1}, {Name: "b", Count: 1}}
	if err := svc.Upsert(&rows, "name"); err != nil {
		t.Fatalf("first upsert: %v", err)
	}

	rows[0].Count = 5
	rows[1].Count = 7
	rows[0].Id = 0
	rows[1].Id = 0
	if err := svc.Upsert(&rows, "name"); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	var got []testRecord
	if err := svc.Find(&got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("upsert duplicated rows: expected 2, got %d", len(got))
	}

	total := 0
	for _, r := range got {
		total += r.Count
	}
	if total != 12 {
		t.Fatalf("conflict rows were not updated: counts sum to %d, want 12", total)
	}
}

func TestGetOrCreate(t *testing.T) {
	svc := newTestService(t)

	first := testRecord{Name: "goc", Count: 1}
	if err := svc.GetOrCreate(&first, testRecord{Name: "goc"}); err != nil {
		t.Fatalf("create: %v", err)
	}

	second := testRecord{}
	if err := svc.GetOrCreate(&second, testRecord{Name: "goc"}); err != nil {
		t.Fatalf("get: %v", err)
	}
	if second.Id != first.Id || second.Count != 1 {
		t.Fatalf("expected existing row {Id:%d Count:1}, got %+v", first.Id, second)
	}

	var got []testRecord
	if err := svc.Find(&got, "name = ?", "goc"); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("second call created a duplicate: %d rows", len(got))
	}
}

func TestTransactionRollsBackOnError(t *testing.T) {
	svc := newTestService(t)

	sentinel := errors.New("boom")
	err := svc.Transaction(func(tx Service) error {
		if err := tx.Insert(&testRecord{Name: "tx-rollback", Count: 1}); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}

	var got []testRecord
	if err := svc.Find(&got, "name = ?", "tx-rollback"); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("insert was not rolled back")
	}
}

func TestTransactionCommits(t *testing.T) {
	svc := newTestService(t)

	err := svc.Transaction(func(tx Service) error {
		return tx.Insert(&testRecord{Name: "tx-commit", Count: 1})
	})
	if err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var got []testRecord
	if err := svc.Find(&got, "name = ?", "tx-commit"); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 1 {
		t.Fatal("committed row missing")
	}
}
