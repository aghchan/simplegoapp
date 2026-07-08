package mongo

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

type thing struct {
	Name  string `bson:"name"`
	Count int    `bson:"count"`
}

func newTestService(t *testing.T) Service {
	t.Helper()

	conn, err := net.DialTimeout("tcp", "localhost:27018", time.Second)
	if err != nil {
		t.Skip(`mongo not running on :27018; start with:
docker run -d --rm --name simplegoapp-test-mongo -p 27018:27018 mongo:7 --replSet rs0 --port 27018
docker exec simplegoapp-test-mongo mongosh --port 27018 --quiet --eval 'try { rs.status().ok } catch (e) { rs.initiate({_id:"rs0", members:[{_id:0, host:"localhost:27018"}]}).ok }'`)
	}
	conn.Close()
	waitForPrimary(t)

	svc := NewService(
		map[string]interface{}{
			"mongo_host":     "localhost",
			"mongo_port":     "27018",
			"mongo_database": "simplegoapp_test",
		},
		logger.NewService(),
	)
	svc.(*service).database.Collection("things").Drop(context.Background())

	return svc
}

func waitForPrimary(t *testing.T) {
	t.Helper()

	client, err := mongo.Connect(
		context.Background(),
		options.Client().ApplyURI("mongodb://localhost:27018"),
	)
	if err != nil {
		t.Skipf("mongo connect: %v", err)
	}
	defer client.Disconnect(context.Background())

	for i := 0; i < 30; i++ {
		if err := client.Ping(context.Background(), readpref.Primary()); err == nil {
			return
		}
		time.Sleep(time.Second)
	}
	t.Skip("mongo replica set has no primary; run the rs.initiate command (see newTestService)")
}

func TestFindWithContext(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Insert(ctx, "things", []thing{{Name: "a"}, {Name: "b"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": "a"}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 doc, got %d", len(got))
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := svc.Find(cancelled, "things", M{"name": "a"}, &got); err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestBulkUpsertInsertsAndUpdates(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	filters := []interface{}{M{"name": "a"}, M{"name": "b"}}
	if err := svc.BulkUpsert(ctx, "things", filters, []interface{}{
		M{"$set": M{"count": 1}},
		M{"$set": M{"count": 2}},
	}); err != nil {
		t.Fatalf("first bulk upsert: %v", err)
	}

	if err := svc.BulkUpsert(ctx, "things", filters, []interface{}{
		M{"$set": M{"count": 10}},
		M{"$set": M{"count": 20}},
	}); err != nil {
		t.Fatalf("second bulk upsert: %v", err)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": M{"$exists": true}}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("upsert duplicated docs: expected 2, got %d", len(got))
	}

	total := 0
	for _, d := range got {
		total += d.Count
	}
	if total != 30 {
		t.Fatalf("docs were not updated: counts sum to %d, want 30", total)
	}
}

func TestBulkUpsertRejectsMismatchedLengths(t *testing.T) {
	svc := newTestService(t)

	err := svc.BulkUpsert(context.Background(), "things",
		[]interface{}{M{"name": "a"}},
		[]interface{}{M{"$set": M{"count": 1}}, M{"$set": M{"count": 2}}},
	)
	if err != ErrMismatchedBulk {
		t.Fatalf("expected ErrMismatchedBulk, got %v", err)
	}
}

func TestBulkUpsertRejectsEmptyFilter(t *testing.T) {
	svc := newTestService(t)

	err := svc.BulkUpsert(context.Background(), "things",
		[]interface{}{M{}},
		[]interface{}{M{"$set": M{"count": 1}}},
	)
	if err != ErrNoFilter {
		t.Fatalf("expected ErrNoFilter, got %v", err)
	}
}

func TestFindRejectsNilFilter(t *testing.T) {
	svc := newTestService(t)

	var got []thing
	if err := svc.Find(context.Background(), "things", nil, &got); err != ErrNoFilter {
		t.Fatalf("expected ErrNoFilter for nil filter, got %v", err)
	}
}

func TestBulkUpsertRejectsNilFilter(t *testing.T) {
	svc := newTestService(t)

	err := svc.BulkUpsert(context.Background(), "things",
		[]interface{}{nil},
		[]interface{}{M{"$set": M{"count": 1}}},
	)
	if err != ErrNoFilter {
		t.Fatalf("expected ErrNoFilter for nil filter, got %v", err)
	}
}

func TestBulkUpsertRejectsEmptySliceFilter(t *testing.T) {
	svc := newTestService(t)

	err := svc.BulkUpsert(context.Background(), "things",
		[]interface{}{D{}},
		[]interface{}{M{"$set": M{"count": 1}}},
	)
	if err != ErrNoFilter {
		t.Fatalf("expected ErrNoFilter for empty bson.D filter, got %v", err)
	}
}

func TestInsertWithCustomIdDoesNotPanic(t *testing.T) {
	svc := newTestService(t)

	ids, err := svc.Insert(context.Background(), "things", M{"_id": "custom-id", "name": "x"})
	if err != nil {
		t.Fatalf("insert with custom id: %v", err)
	}
	if len(ids) != 1 {
		t.Fatalf("expected 1 returned id slot, got %d", len(ids))
	}
}

func TestUpdateModifiesMatchingDocuments(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Insert(ctx, "things", []thing{{Name: "u1", Count: 1}, {Name: "u2", Count: 1}}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	if err := svc.Update(ctx, "things", M{"name": "u1"}, M{"$set": M{"count": 9}}); err != nil {
		t.Fatalf("update: %v", err)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": M{"$in": A{"u1", "u2"}}}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	for _, d := range got {
		if d.Name == "u1" && d.Count != 9 {
			t.Fatalf("u1 was not updated: %+v", d)
		}
		if d.Name == "u2" && d.Count != 1 {
			t.Fatalf("u2 should not have been touched: %+v", d)
		}
	}
}

func TestFindOneAndUpdateReturnsPreviousDocument(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Insert(ctx, "things", thing{Name: "fau", Count: 1}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	var prev thing
	if err := svc.FindOneAndUpdate(ctx, "things", M{"name": "fau"}, M{"$set": M{"count": 5}}, &prev); err != nil {
		t.Fatalf("findOneAndUpdate: %v", err)
	}
	if prev.Count != 1 {
		t.Fatalf("expected pre-update document with count 1, got %+v", prev)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": "fau"}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 1 || got[0].Count != 5 {
		t.Fatalf("expected updated count 5, got %+v", got)
	}
}

func TestTransactionRejectsNesting(t *testing.T) {
	svc := newTestService(t)

	err := svc.Transaction(context.Background(), func(tx Service) error {
		return tx.Transaction(context.Background(), func(Service) error { return nil })
	})
	if !errors.Is(err, ErrNestedTransaction) {
		t.Fatalf("expected ErrNestedTransaction, got %v", err)
	}
}

func TestTransactionReadsOwnWrites(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	sentinel := errors.New("rollback")
	err := svc.Transaction(ctx, func(tx Service) error {
		if _, err := tx.Insert(ctx, "things", thing{Name: "tx-visible"}); err != nil {
			return err
		}

		var inTx []thing
		if err := tx.Find(ctx, "things", M{"name": "tx-visible"}, &inTx); err != nil {
			return err
		}
		if len(inTx) != 1 {
			t.Errorf("tx-bound Find should see the uncommitted write, got %d docs", len(inTx))
		}

		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": "tx-visible"}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("write should have been rolled back")
	}
}

func TestTransactionRollsBackOnError(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	sentinel := errors.New("boom")
	err := svc.Transaction(ctx, func(tx Service) error {
		if _, err := tx.Insert(ctx, "things", thing{Name: "tx-rollback"}); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": "tx-rollback"}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("insert was not rolled back")
	}
}

func TestTransactionCommits(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	err := svc.Transaction(ctx, func(tx Service) error {
		_, err := tx.Insert(ctx, "things", thing{Name: "tx-commit"})
		return err
	})
	if err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var got []thing
	if err := svc.Find(ctx, "things", M{"name": "tx-commit"}, &got); err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(got) != 1 {
		t.Fatal("committed doc missing")
	}
}
